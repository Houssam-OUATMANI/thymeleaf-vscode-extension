import {
  CodeActionKind,
  createConnection,
  DidChangeConfigurationNotification,
  InitializeParams,
  InitializeResult,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  DEFAULT_SETTINGS,
  provideCodeActions,
  ThymeleafSettings,
  validateDocument,
  validateJavaDocument
} from "./features/diagnosticsProvider";
import { provideCompletions } from "./features/completionProvider";
import {
  provideDefinition,
  provideHover,
  provideTypeDefinition,
  prepareThymeleafRename,
  provideThymeleafRenameEdits,
  provideReferences
} from "./features/navigationProvider";
import {
  provideSemanticTokens,
  SEMANTIC_TOKEN_MODIFIERS,
  SEMANTIC_TOKEN_TYPES
} from "./features/semanticTokensProvider";
import { provideCodeLenses, provideGutterDecorations } from "./features/codeLensProvider";
import { CompilerJavaType, ProjectIndex } from "./projectIndex";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const projectIndex = new ProjectIndex();

let workspaceUris: string[] = [];
let settings: ThymeleafSettings = DEFAULT_SETTINGS;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let refreshQueue: Promise<void> = Promise.resolve();

connection.onInitialize((params: InitializeParams): InitializeResult => {
  workspaceUris = (params.workspaceFolders ?? [])
    .map(({ uri }) => uri)
    .filter((uri): uri is string => uri.startsWith("file:"));
  if (workspaceUris.length === 0 && params.rootUri?.startsWith("file:")) {
    workspaceUris = [params.rootUri];
  }

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        triggerCharacters: [" ", ":", "{", "$", "*", "#", "@", "~", "."]
      },
      definitionProvider: true,
      typeDefinitionProvider: true,
      referencesProvider: true,
      hoverProvider: true,
      codeActionProvider: {
        codeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.RefactorExtract]
      },
      codeLensProvider: {
        resolveProvider: false
      },
      semanticTokensProvider: {
        legend: {
          tokenTypes: SEMANTIC_TOKEN_TYPES,
          tokenModifiers: SEMANTIC_TOKEN_MODIFIERS
        },
        full: true
      },
      workspace: {
        workspaceFolders: {
          supported: true,
          changeNotifications: true
        }
      }
    },
    serverInfo: {
      name: "Thymeleaf Language Server",
      version: "0.3.0"
    }
  };
});

connection.onInitialized(async () => {
  await connection.client.register(DidChangeConfigurationNotification.type);
  connection.workspace.onDidChangeWorkspaceFolders(({ added, removed: removedFolders }) => {
    const removed = new Set(removedFolders.map(({ uri }) => uri));
    workspaceUris = [
      ...workspaceUris.filter((uri) => !removed.has(uri)),
      ...added.map(({ uri }) => uri).filter((uri) => uri.startsWith("file:"))
    ];
    scheduleIndexRefresh();
  });
  await refreshProjectIndex().catch((error: unknown) => {
    connection.console.error(`Unable to initialize the Thymeleaf project index: ${formatError(error)}`);
  });
});

connection.onDidChangeConfiguration((change) => {
  settings = normalizeSettings(change.settings);
  scheduleIndexRefresh();
  publishAllDiagnostics();
});

documents.onDidOpen(({ document }) => {
  if (
    document.languageId === "html" &&
    !projectIndex.updateOpenTemplate(document.uri, document.getText())
  ) {
    scheduleIndexRefresh();
  }
  validateAndPublish(document);
});

documents.onDidChangeContent(({ document }) => {
  if (
    document.languageId === "html" &&
    !projectIndex.updateOpenTemplate(document.uri, document.getText())
  ) {
    scheduleIndexRefresh();
  }
  validateAndPublish(document);
});

documents.onDidSave(() => {
  scheduleIndexRefresh();
});

documents.onDidClose(({ document }) => {
  connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
  if (document.languageId === "html") projectIndex.closeOpenTemplate(document.uri);
});

connection.onDidChangeWatchedFiles(() => scheduleIndexRefresh());

connection.onCompletion(({ textDocument, position }) => {
  const document = documents.get(textDocument.uri);
  return document ? provideCompletions(document, position, projectIndex) : [];
});

connection.onDefinition(({ textDocument, position }) => {
  const document = documents.get(textDocument.uri);
  return document ? provideDefinition(document, position, projectIndex) : undefined;
});

connection.onTypeDefinition(({ textDocument, position }) => {
  const document = documents.get(textDocument.uri);
  return document ? provideTypeDefinition(document, position, projectIndex) : undefined;
});

connection.onHover(({ textDocument, position }) => {
  const document = documents.get(textDocument.uri);
  return document ? provideHover(document, position, projectIndex) : undefined;
});

connection.onReferences(({ textDocument, position }) => {
  const document = documents.get(textDocument.uri);
  return document ? provideReferences(document, position, projectIndex) : [];
});

connection.onRequest("thymeleaf/prepareRename", ({ textDocument, position }) => {
  const document = documents.get(textDocument.uri);
  return document ? prepareThymeleafRename(document, position, projectIndex) : undefined;
});

connection.onRequest(
  "thymeleaf/rename",
  (params: {
    readonly javaUri: string;
    readonly javaPosition: { readonly line: number; readonly character: number };
    readonly newName: string;
  }) =>
    provideThymeleafRenameEdits(
      params.javaUri,
      params.javaPosition,
      params.newName,
      projectIndex,
      new Map(documents.all()
        .filter(({ languageId }) => languageId === "html")
        .map((document) => [document.uri, document.getText()]))
    )
);

connection.onNotification(
  "thymeleaf/javaCompilerTypes",
  (types: readonly CompilerJavaType[]) => {
    projectIndex.addCompilerJavaTypes(types);
    publishAllDiagnostics();
  }
);

connection.onNotification("thymeleaf/resetJavaCompilerTypes", () => {
  projectIndex.clearCompilerJavaTypes();
});

connection.onCodeAction(({ textDocument, range, context }) => {
  const document = documents.get(textDocument.uri);
  return document ? provideCodeActions(document, range, context.diagnostics, projectIndex) : [];
});

connection.onCodeLens(({ textDocument }) => {
  const document = documents.get(textDocument.uri);
  return document ? provideCodeLenses(document, projectIndex) : [];
});

connection.onRequest("thymeleaf/gutterDecorations", (params: { readonly uri: string; readonly languageId: string }) => {
  return provideGutterDecorations(params.uri, params.languageId, projectIndex);
});

connection.languages.semanticTokens.on(({ textDocument }) => {
  const document = documents.get(textDocument.uri);
  return document ? provideSemanticTokens(document, projectIndex) : { data: [] };
});

documents.listen(connection);
connection.listen();

function scheduleIndexRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    void refreshProjectIndex().catch((error: unknown) => {
      connection.console.error(`Unable to index the Thymeleaf project: ${formatError(error)}`);
    });
  }, 300);
}

function refreshProjectIndex(): Promise<void> {
  const refresh = refreshQueue.then(async () => {
    const openDocuments = new Map(documents.all().map((document) => [document.uri, document.getText()]));
    await projectIndex.refresh(workspaceUris, settings.templateLocations, openDocuments);
    connection.sendNotification(
      "thymeleaf/javaTypeReferences",
      projectIndex.javaTypeReferences
    );
    publishAllDiagnostics();
  });
  refreshQueue = refresh.catch(() => undefined);
  return refresh;
}

function validateAndPublish(document: TextDocument): void {
  if (document.languageId === "html") {
    connection.sendDiagnostics({
      uri: document.uri,
      diagnostics: validateDocument(document, projectIndex, settings)
    });
  } else if (document.languageId === "java") {
    connection.sendDiagnostics({
      uri: document.uri,
      diagnostics: validateJavaDocument(document, projectIndex)
    });
  }
}

function publishAllDiagnostics(): void {
  for (const document of documents.all()) validateAndPublish(document);
}

function normalizeSettings(value: unknown): ThymeleafSettings {
  if (!isRecord(value)) return DEFAULT_SETTINGS;
  const source = isRecord(value.thymeleaf) ? value.thymeleaf : value;
  const validationValue = isRecord(source.validation) ? source.validation : {};
  const templateLocations = Array.isArray(source.templateLocations)
    ? source.templateLocations.filter((location): location is string => typeof location === "string")
    : DEFAULT_SETTINGS.templateLocations;

  return {
    templateLocations,
    validation: {
      unclosedExpressions: readBoolean(validationValue.unclosedExpressions, DEFAULT_SETTINGS.validation.unclosedExpressions),
      unknownAttributes: readBoolean(validationValue.unknownAttributes, DEFAULT_SETTINGS.validation.unknownAttributes),
      unknownModelProperties: readBoolean(validationValue.unknownModelProperties, DEFAULT_SETTINGS.validation.unknownModelProperties)
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoolean(value: unknown, defaultValue: boolean): boolean {
  return typeof value === "boolean" ? value : defaultValue;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
