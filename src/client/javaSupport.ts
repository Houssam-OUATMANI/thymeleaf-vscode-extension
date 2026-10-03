import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node";
import { CompilerJavaType } from "../server/projectIndex";
import { JavaTypeReference } from "../server/javaIndexer";

interface JavaExtensionApi {
  readonly status: string;
  readonly serverMode: string;
  serverReady(): Promise<boolean>;
  getClasspaths(
    uri: string,
    options: { readonly scope: string }
  ): Promise<{ readonly projectRoot: string; readonly classpaths: readonly string[]; readonly modulepaths: readonly string[] }>;
  getDocumentSymbols(params: { readonly textDocument: { readonly uri: string } }): Promise<unknown>;
  goToDefinition(params: {
    readonly textDocument: { readonly uri: string };
    readonly position: { readonly line: number; readonly character: number };
  }): Promise<unknown>;
  readonly onDidClasspathUpdate: vscode.Event<vscode.Uri>;
  readonly onDidProjectsImport: vscode.Event<readonly vscode.Uri[]>;
}

interface RenameInfo {
  readonly placeholder: string;
  readonly range: ProtocolRange;
  readonly javaUri: string;
  readonly javaPosition: ProtocolPosition;
  readonly declarationRange: ProtocolRange;
}

interface ThymeleafRenameEdit {
  readonly uri: string;
  readonly range: ProtocolRange;
  readonly newText: string;
}

interface ProtocolPosition {
  readonly line: number;
  readonly character: number;
}

interface ProtocolRange {
  readonly start: ProtocolPosition;
  readonly end: ProtocolPosition;
}

interface JavaSymbolLike {
  readonly name?: unknown;
  readonly detail?: unknown;
  readonly kind?: unknown;
  readonly range?: unknown;
  readonly selectionRange?: unknown;
  readonly children?: unknown;
  readonly location?: unknown;
}

const NON_RESOLVABLE_TYPES = new Set([
  "boolean", "byte", "char", "short", "int", "long", "float", "double", "void",
  "String", "Integer", "Long", "Double", "Float", "Boolean", "Byte", "Short", "Character",
  "Object", "UUID", "BigDecimal", "BigInteger", "Date", "LocalDate", "LocalTime",
  "LocalDateTime", "OffsetDateTime", "ZonedDateTime", "Instant", "List", "Set",
  "Map", "Collection", "Optional", "Iterable"
]);

export function registerJavaSupport(
  context: vscode.ExtensionContext,
  client: LanguageClient,
  output: vscode.OutputChannel,
  fileWatcher: vscode.FileSystemWatcher
): void {
  let javaApiPromise: Promise<JavaExtensionApi | undefined> | undefined;
  let classpathReport: Promise<void> | undefined;
  let latestReferences: readonly JavaTypeReference[] = [];
  const resolvedTypes = new Map<string, CompilerJavaType>();
  const invalidateDocumentTypes = (uri: vscode.Uri): void => {
    if (!/\.java$/i.test(uri.fsPath)) return;
    const prefix = `${uri.toString()}:`;
    const changedUri = uri.toString();
    for (const [key, type] of resolvedTypes) {
      if (key.startsWith(prefix) || type.uri === changedUri) resolvedTypes.delete(key);
    }
  };

  const typeReferenceRegistration = client.onNotification(
    "thymeleaf/javaTypeReferences",
    (references: readonly JavaTypeReference[]) => {
      latestReferences = references;
      void resolveCompilerTypes(references).catch((error: unknown) => {
        output.appendLine(`Java compiler symbol indexing failed: ${formatError(error)}`);
      });
    }
  );
  context.subscriptions.push(typeReferenceRegistration);
  context.subscriptions.push(
    fileWatcher.onDidChange(invalidateDocumentTypes),
    fileWatcher.onDidCreate(invalidateDocumentTypes),
    fileWatcher.onDidDelete(invalidateDocumentTypes),
    vscode.workspace.onDidChangeTextDocument(({ document }) => invalidateDocumentTypes(document.uri))
  );

  const renameProvider = vscode.languages.registerRenameProvider(
    [{ language: "html", scheme: "file" }, { language: "java", scheme: "file" }],
    {
      prepareRename: async (document, position, token) => {
        const direct = await requestRenameInfo(client, document, position, token);
        if (direct) return { range: protocolRange(direct.range), placeholder: direct.placeholder };
        if (document.languageId !== "java") return undefined;

        const definitions = normalizeDefinitions(await vscode.commands.executeCommand<unknown>(
          "vscode.executeDefinitionProvider",
          document.uri,
          position
        ));
        const declaration = definitions?.find(({ uri }) => uri.scheme === "file");
        if (!declaration) return undefined;
        const declarationDocument = await documentFromUri(declaration.uri);
        const info = await requestRenameInfo(client, declarationDocument, declaration.range.start, token);
        const wordRange = document.getWordRangeAtPosition(position);
        return info
          ? { range: wordRange ?? protocolRange(info.range), placeholder: info.placeholder }
          : undefined;
      },
      provideRenameEdits: async (document, position, newName, token) => {
        if (!isValidJavaIdentifier(newName)) {
          void vscode.window.showErrorMessage(`'${newName}' is not a valid Java identifier.`);
          return undefined;
        }

        let info = await requestRenameInfo(client, document, position, token);
        if (!info && document.languageId === "java") {
          const definitions = normalizeDefinitions(await vscode.commands.executeCommand<unknown>(
            "vscode.executeDefinitionProvider",
            document.uri,
            position
          ));
          const declaration = definitions?.find(({ uri }) => uri.scheme === "file");
          if (declaration) {
            const declarationDocument = await documentFromUri(declaration.uri);
            info = await requestRenameInfo(
              client,
              declarationDocument,
              declaration.range.start,
              token
            );
          }
        }
        if (!info) return undefined;

        const javaReferences = await vscode.commands.executeCommand<vscode.Location[]>(
          "vscode.executeReferenceProvider",
          vscode.Uri.parse(info.javaUri),
          new vscode.Position(info.javaPosition.line, info.javaPosition.character)
        );
        if (!javaReferences) {
          void vscode.window.showErrorMessage("The Java language server did not return symbol references; rename was cancelled.");
          return undefined;
        }

        const thymeleafEdits = await client.sendRequest<readonly ThymeleafRenameEdit[]>(
          "thymeleaf/rename",
          {
            javaUri: info.javaUri,
            javaPosition: info.javaPosition,
            newName,
            documentUri: document.uri.toString()
          },
          token
        );
        const workspaceEdit = new vscode.WorkspaceEdit();
        const editsByLocation = new Map<string, { readonly uri: vscode.Uri; readonly range: vscode.Range }>();
        const addEdit = (uri: vscode.Uri, range: vscode.Range): void => {
          const key = `${uri.toString()}:${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
          editsByLocation.set(key, { uri, range });
        };

        for (const reference of javaReferences) {
          if (reference.uri.scheme === "file" && /\.java$/i.test(reference.uri.fsPath)) {
            addEdit(reference.uri, reference.range);
          }
        }
        addEdit(
          vscode.Uri.parse(info.javaUri),
          protocolRange(info.declarationRange)
        );
        for (const edit of thymeleafEdits) {
          addEdit(
            vscode.Uri.parse(edit.uri),
            protocolRange(edit.range)
          );
        }
        for (const { uri, range } of editsByLocation.values()) {
          workspaceEdit.replace(uri, range, newName);
        }
        return workspaceEdit;
      }
    }
  );
  context.subscriptions.push(renameProvider);

  void loadJavaApi()
    .then(async (api) => {
      if (!api) {
        output.appendLine("The Java extension API is unavailable; using source-only Java analysis.");
        return;
      }
      context.subscriptions.push(api.onDidClasspathUpdate(() => {
        resolvedTypes.clear();
        classpathReport = undefined;
        void (async () => {
          await client.sendNotification("thymeleaf/resetJavaCompilerTypes");
          await resolveCompilerTypes(latestReferences);
        })().catch((error: unknown) => {
          output.appendLine(`Java classpath refresh failed: ${formatError(error)}`);
        });
      }));
      context.subscriptions.push(api.onDidProjectsImport(() => {
        resolvedTypes.clear();
        classpathReport = undefined;
        void (async () => {
          await client.sendNotification("thymeleaf/resetJavaCompilerTypes");
          await resolveCompilerTypes(latestReferences);
        })().catch((error: unknown) => {
          output.appendLine(`Java project import refresh failed: ${formatError(error)}`);
        });
      }));
      await reportJavaClasspaths(api);
      await resolveCompilerTypes(latestReferences);
    })
    .catch((error: unknown) => {
      output.appendLine(`Unable to initialize Java compiler integration: ${formatError(error)}`);
    });

  async function loadJavaApi(): Promise<JavaExtensionApi | undefined> {
    javaApiPromise ??= (async () => {
      const extension = vscode.extensions.getExtension<JavaExtensionApi>("redhat.java");
      if (!extension) return undefined;
      const api = extension.isActive ? extension.exports : await extension.activate();
      return typeof api.serverReady === "function" &&
        typeof api.getClasspaths === "function" &&
        typeof api.getDocumentSymbols === "function" &&
        typeof api.goToDefinition === "function" &&
        typeof api.onDidClasspathUpdate === "function" &&
        typeof api.onDidProjectsImport === "function"
        ? api
        : undefined;
    })();
    return javaApiPromise;
  }

  async function reportJavaClasspaths(api: JavaExtensionApi): Promise<void> {
    classpathReport ??= (async () => {
      const ready = await api.serverReady();
      if (!ready) {
        output.appendLine("Java Language Server is not in Standard mode; compiler-backed Thymeleaf resolution is unavailable.");
        return;
      }
      const allProjects = await vscode.commands.executeCommand<unknown>("java.project.getAll");
      const projectUris = Array.isArray(allProjects)
        ? allProjects.filter((value): value is string => typeof value === "string")
        : [];
      const classpathResults = await Promise.all(projectUris.map(async (projectUri) => {
        try {
          return await api.getClasspaths(projectUri, { scope: "runtime" });
        } catch (error) {
          output.appendLine(`Could not read Java classpath for ${projectUri}: ${formatError(error)}`);
          return undefined;
        }
      }));
      const projects = classpathResults.filter(
        (result): result is NonNullable<typeof result> => result !== undefined
      );
      if (projects.length === 0) {
        output.appendLine("Java Language Server has not imported a Java project yet; source-only resolution remains active.");
        return;
      }
      output.appendLine(
        `Java Language Server classpath integration active for ${projects.length} project(s), ` +
        `${projects.reduce((total, project) => total + project.classpaths.length + project.modulepaths.length, 0)} entries.`
      );
    })();
    await classpathReport;
  }

  async function resolveCompilerTypes(
    references: readonly JavaTypeReference[]
  ): Promise<void> {
    const api = await loadJavaApi();
    if (!api || !(await api.serverReady())) return;
    await reportJavaClasspaths(api);

    const relevantTypes = new Map<string, JavaTypeReference>();
    for (const reference of references) {
      const { typeName } = reference;
      const simpleName = typeName.split(".").at(-1) ?? typeName;
      if (NON_RESOLVABLE_TYPES.has(simpleName) || !/^[A-Z]/.test(simpleName)) continue;
      const resolutionKey = typeReferenceKey(reference);
      if (!relevantTypes.has(resolutionKey)) relevantTypes.set(resolutionKey, reference);
    }
    const relevant = [...relevantTypes.values()];
    await runWithConcurrency(relevant, 6, async (reference) => {
      const key = typeReferenceKey(reference);
      if (resolvedTypes.has(key)) return;
      const resolved = await resolveCompilerType(api, reference);
      if (resolved) resolvedTypes.set(key, resolved);
    });
    const currentKeys = new Set(relevant.map(typeReferenceKey));
    const currentTypes = [...resolvedTypes]
      .filter(([key]) => currentKeys.has(key))
      .map(([, type]) => type);
    const uniqueTypes = new Map<string, CompilerJavaType>();
    for (const type of currentTypes) {
      uniqueTypes.set(`${type.uri}:${type.name}:${type.alias}`, type);
    }
    if (uniqueTypes.size > 0) {
      await client.sendNotification("thymeleaf/javaCompilerTypes", [...uniqueTypes.values()]);
    }
  }
}

async function requestRenameInfo(
  client: LanguageClient,
  document: vscode.TextDocument,
  position: vscode.Position,
  token: vscode.CancellationToken
): Promise<RenameInfo | undefined> {
  return client.sendRequest<RenameInfo | undefined>(
    "thymeleaf/prepareRename",
    {
      textDocument: { uri: document.uri.toString() },
      position: { line: position.line, character: position.character }
    },
    token
  );
}

async function documentFromUri(uri: vscode.Uri): Promise<vscode.TextDocument> {
  return vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString()) ??
    await vscode.workspace.openTextDocument(uri);
}

async function resolveCompilerType(
  api: JavaExtensionApi,
  reference: JavaTypeReference
): Promise<CompilerJavaType | undefined> {
  const definitions = normalizeDefinitions(await api.goToDefinition({
    textDocument: { uri: reference.uri },
    position: reference.position
  }));
  if (definitions.length !== 1) return undefined;
  const definition = definitions[0];
  if (!definition) return undefined;

  const symbols = normalizeSymbols(await api.getDocumentSymbols({
    textDocument: { uri: definition.uri.toString() }
  }));
  const targetName = reference.typeName.split(".").at(-1) ?? reference.typeName;
  const typeCandidates = flattenSymbols(symbols).filter(({ name, kind }) =>
    name === targetName && isClassSymbolKind(kind)
  );
  const matchingCandidates = typeCandidates.filter((candidate) => {
    const range = getSymbolRange(candidate.range);
    return range?.contains(definition.range.start) ?? false;
  });
  const typeSymbol = matchingCandidates.length === 1
    ? matchingCandidates[0]
    : typeCandidates.length === 1 ? typeCandidates[0] : undefined;
  if (!typeSymbol) return undefined;
  const selectionRange = getSymbolRange(typeSymbol.selectionRange) ?? getSymbolRange(typeSymbol.range);
  if (!selectionRange) return undefined;
  const typeDetail = getString(typeSymbol.detail) ?? "";
  const superClassName = /\bextends\s+([\w.$]+)/.exec(typeDetail)?.[1];
  const typeParameters = /<([^<>]+)>/.exec(typeDetail)?.[1]
    ?.split(",")
    .map((parameter) => parameter.trim().split(/\s+/)[0])
    .filter((parameter): parameter is string => parameter !== undefined && /^[A-Za-z_$][\w$]*$/.test(parameter));

  const properties: CompilerJavaType["properties"][number][] = [];
  const methods: CompilerJavaType["methods"][number][] = [];
  for (const member of normalizeSymbols(typeSymbol.children)) {
    const name = getString(member.name);
    const detail = getString(member.detail) ?? "";
    if (!name) continue;
    if (member.kind === vscode.SymbolKind.Field || member.kind === vscode.SymbolKind.Property) {
      const range = getSymbolRange(member.selectionRange) ?? getSymbolRange(member.range);
      const typeName = symbolType(detail, false);
      if (range && typeName) {
        properties.push({
          name,
          typeName,
          position: { line: range.start.line, character: range.start.character }
        });
      }
    } else if (member.kind === vscode.SymbolKind.Method) {
      const returnType = symbolType(detail, true);
      const range = getSymbolRange(member.selectionRange) ?? getSymbolRange(member.range);
      if (returnType) {
        methods.push({
          name,
          returnType,
          ...(range && { position: { line: range.start.line, character: range.start.character } })
        });
      }
    }
  }

  return {
    alias: reference.typeName,
    name: getString(typeSymbol.name) ?? targetName,
    uri: definition.uri.toString(),
    position: { line: selectionRange.start.line, character: selectionRange.start.character },
    ...(superClassName && { superClassName }),
    ...(typeParameters && typeParameters.length > 0 && { typeParameters }),
    properties,
    methods
  };
}

function normalizeDefinitions(value: unknown): vscode.Location[] {
  const candidates = Array.isArray(value) ? value : value ? [value] : [];
  const locations: vscode.Location[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const uri = normalizeUri(candidate.uri) ?? normalizeUri(candidate.targetUri);
    const range = getSymbolRange(candidate.range) ??
      getSymbolRange(candidate.targetSelectionRange) ??
      getSymbolRange(candidate.targetRange);
    if (!uri || !range) continue;
    locations.push(new vscode.Location(uri, range));
  }
  return locations;
}

function normalizeUri(value: unknown): vscode.Uri | undefined {
  if (value instanceof vscode.Uri) return value;
  if (typeof value === "string") return vscode.Uri.parse(value);
  if (!isRecord(value) || typeof value.scheme !== "string") return undefined;
  return vscode.Uri.from({
    scheme: value.scheme,
    authority: getString(value.authority) ?? "",
    path: getString(value.path) ?? "",
    query: getString(value.query) ?? "",
    fragment: getString(value.fragment) ?? ""
  });
}

function normalizeSymbols(value: unknown): JavaSymbolLike[] {
  return Array.isArray(value)
    ? value.filter((symbol): symbol is JavaSymbolLike => isRecord(symbol))
    : [];
}

function flattenSymbols(symbols: readonly JavaSymbolLike[]): JavaSymbolLike[] {
  return symbols.flatMap((symbol) => [
    symbol,
    ...flattenSymbols(normalizeSymbols(symbol.children))
  ]);
}

function isClassSymbolKind(kind: unknown): boolean {
  return kind === vscode.SymbolKind.Class ||
    kind === vscode.SymbolKind.Interface ||
    kind === vscode.SymbolKind.Enum ||
    kind === vscode.SymbolKind.Struct;
}

function getSymbolRange(value: unknown): vscode.Range | undefined {
  if (!isRecord(value) || !isRecord(value.start) || !isRecord(value.end)) return undefined;
  const startLine = getNumber(value.start.line);
  const startCharacter = getNumber(value.start.character);
  const endLine = getNumber(value.end.line);
  const endCharacter = getNumber(value.end.character);
  if (startLine === undefined || startCharacter === undefined || endLine === undefined || endCharacter === undefined) {
    return undefined;
  }
  return new vscode.Range(startLine, startCharacter, endLine, endCharacter);
}

function symbolType(detail: string, method: boolean): string | undefined {
  const normalized = detail.replace(/\s+/g, " ").trim();
  const colonType = /:\s*([\w.$<>?,\[\]]+)\s*(?:\{|$)/.exec(normalized)?.[1];
  if (colonType) return colonType;
  const methodType = method
    ? /(?:^|\s)([\w.$<>?,\[\]]+)\s+[\w$]+\s*\(/.exec(normalized)?.[1]
    : undefined;
  if (methodType) return methodType;
  const fieldType = !method
    ? /(?:^|\s)([\w.$<>?,\[\]]+)\s+[\w$]+\s*(?:=.*)?$/.exec(normalized)?.[1]
    : undefined;
  return fieldType;
}

function typeReferenceKey(reference: JavaTypeReference): string {
  return `${reference.uri}:${reference.position.line}:${reference.position.character}:${reference.typeName}`;
}

function protocolRange(range: ProtocolRange): vscode.Range {
  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character
  );
}

function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  callback: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  return Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await callback(items[index]);
    }
  })).then(() => undefined);
}

function isValidJavaIdentifier(value: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(value) && !JAVA_KEYWORDS.has(value);
}

const JAVA_KEYWORDS = new Set([
  "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class",
  "const", "continue", "default", "do", "double", "else", "enum", "extends", "final",
  "finally", "float", "for", "goto", "if", "implements", "import", "instanceof", "int",
  "interface", "long", "native", "new", "package", "private", "protected", "public",
  "return", "short", "static", "strictfp", "super", "switch", "synchronized", "this",
  "throw", "throws", "transient", "try", "void", "volatile", "while", "true", "false", "null"
]);

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
