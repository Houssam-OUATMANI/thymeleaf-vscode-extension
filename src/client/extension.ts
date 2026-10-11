import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind
} from "vscode-languageclient/node";
import { registerJavaSupport } from "./javaSupport";

let languageClient: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const serverModule = context.asAbsolutePath(path.join("dist", "server.js"));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ["--nolazy", "--inspect=6009"] }
    }
  };

  const fileWatcher = vscode.workspace.createFileSystemWatcher("**/*.{html,java,properties}");
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { language: "html", scheme: "file" },
      { language: "java", scheme: "file" }
    ],
    synchronize: {
      configurationSection: "thymeleaf",
      fileEvents: fileWatcher
    },
    outputChannelName: "Thymeleaf Language Server"
  };
  const outputChannel = vscode.window.createOutputChannel("Thymeleaf Companion: Java");

  languageClient = new LanguageClient(
    "thymeleafLanguageServer",
    "Thymeleaf Language Server",
    serverOptions,
    clientOptions
  );

  context.subscriptions.push(fileWatcher, outputChannel, languageClient);
  registerJavaSupport(context, languageClient, outputChannel, fileWatcher);

  context.subscriptions.push(
    vscode.commands.registerCommand("thymeleaf.openTemplate", async (uri: string) => {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
      await vscode.window.showTextDocument(doc);
    }),
    vscode.commands.registerCommand("thymeleaf.openController", async (uri: string, line: number, character: number) => {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
      const pos = new vscode.Position(line, character);
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos) });
    }),
    vscode.commands.registerCommand("thymeleaf.openFragment", async (uri: string, line: number, character: number) => {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
      const pos = new vscode.Position(line, character);
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos) });
    }),
    vscode.commands.registerCommand(
      "thymeleaf.createTemplate",
      async (rawTemplateName?: string, originUri?: string) => {
        try {
          let templateName = rawTemplateName;
          if (!templateName) {
            templateName = await vscode.window.showInputBox({
              prompt: "Enter the Thymeleaf template path to create (e.g. index or admin/users/index)",
              placeHolder: "admin/users/index"
            });
            if (!templateName) return;
          }

          const normalizedName = templateName
            .trim()
            .replace(/\.html$/i, "")
            .replaceAll("\\", "/")
            .replace(/^\/+/, "");

          if (!normalizedName) {
            vscode.window.showErrorMessage("Invalid Thymeleaf template name.");
            return;
          }

          let workspaceFolder: vscode.WorkspaceFolder | undefined;
          if (originUri) {
            try {
              workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(originUri));
            } catch {
              // ignore parse errors
            }
          }
          if (!workspaceFolder && vscode.window.activeTextEditor) {
            workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
          }
          if (!workspaceFolder && vscode.workspace.workspaceFolders?.length) {
            workspaceFolder = vscode.workspace.workspaceFolders[0];
          }
          if (!workspaceFolder) {
            vscode.window.showErrorMessage("No workspace folder found to create the template.");
            return;
          }

          const config = vscode.workspace.getConfiguration("thymeleaf", workspaceFolder.uri);
          const locations: string[] = config.get("templateLocations") || ["src/main/resources/templates"];
          const primaryLocation = locations[0] || "src/main/resources/templates";

          const templateBaseDir = path.resolve(workspaceFolder.uri.fsPath, primaryLocation);
          const targetFilePath = path.resolve(templateBaseDir, `${normalizedName}.html`);
          const targetFileDir = path.dirname(targetFilePath);

          await fs.promises.mkdir(targetFileDir, { recursive: true });

          let fileExisted = false;
          try {
            await fs.promises.access(targetFilePath);
            fileExisted = true;
          } catch {
            const titleName = path.basename(normalizedName);
            const initialContent = `<!DOCTYPE html>
<html xmlns:th="http://www.thymeleaf.org">
<head>
    <meta charset="UTF-8">
    <title>${titleName}</title>
</head>
<body>

</body>
</html>
`;
            await fs.promises.writeFile(targetFilePath, initialContent, "utf8");
          }

          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(targetFilePath));
          await vscode.window.showTextDocument(doc);

          if (!fileExisted) {
            vscode.window.showInformationMessage(
              `Thymeleaf template '${normalizedName}.html' created.`
            );
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          vscode.window.showErrorMessage(`Failed to create template: ${message}`);
        }
      }
    ),
    vscode.commands.registerCommand(
      "thymeleaf.extractFragment",
      async (uriArg?: string, rangeArg?: { start: { line: number; character: number }; end: { line: number; character: number } }) => {
        try {
          let editor = vscode.window.activeTextEditor;
          if (uriArg && (!editor || editor.document.uri.toString() !== uriArg)) {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriArg));
            editor = await vscode.window.showTextDocument(doc);
          }
          if (!editor) return;

          let range: vscode.Range;
          if (rangeArg) {
            range = new vscode.Range(
              new vscode.Position(rangeArg.start.line, rangeArg.start.character),
              new vscode.Position(rangeArg.end.line, rangeArg.end.character)
            );
          } else {
            range = editor.selection;
          }

          if (range.isEmpty) {
            vscode.window.showWarningMessage("Please select HTML content to extract into a fragment.");
            return;
          }

          const fragmentName = await vscode.window.showInputBox({
            prompt: "Enter the Thymeleaf fragment name",
            placeHolder: "myFragment",
            value: "myFragment"
          });
          if (!fragmentName || !fragmentName.trim()) return;

          const trimmedName = fragmentName.trim();
          const doc = editor.document;
          const selectedHtml = doc.getText(range);

          const replaceText = `<div th:replace="~{::${trimmedName}}"></div>`;
          const fragmentDeclaration = `\n<div th:fragment="${trimmedName}">\n${selectedHtml}\n</div>\n`;

          const fullText = doc.getText();
          const bodyCloseIndex = fullText.lastIndexOf("</body>");

          await editor.edit((editBuilder) => {
            editBuilder.replace(range, replaceText);
            if (bodyCloseIndex >= 0) {
              const insertPos = doc.positionAt(bodyCloseIndex);
              editBuilder.insert(insertPos, fragmentDeclaration);
            } else {
              const lastPos = doc.positionAt(fullText.length);
              editBuilder.insert(lastPos, fragmentDeclaration);
            }
          });

          vscode.window.showInformationMessage(`Fragment '${trimmedName}' extracted successfully.`);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          vscode.window.showErrorMessage(`Failed to extract fragment: ${message}`);
        }
      }
    )
  );

  const gutterDecorationType = vscode.window.createTextEditorDecorationType({
    gutterIconPath: vscode.Uri.file(context.asAbsolutePath("icon.png")),
    gutterIconSize: "contain"
  });
  context.subscriptions.push(gutterDecorationType);

  let gutterDebounce: ReturnType<typeof setTimeout> | undefined;
  const updateGutter = (editor?: vscode.TextEditor): void => {
    if (!editor || !languageClient) return;
    const doc = editor.document;
    if (doc.languageId !== "html" && doc.languageId !== "java") return;

    if (gutterDebounce) clearTimeout(gutterDebounce);
    gutterDebounce = setTimeout(async () => {
      try {
        const decorations = await languageClient?.sendRequest<
          readonly { readonly line: number; readonly tooltip: string }[]
        >("thymeleaf/gutterDecorations", {
          uri: doc.uri.toString(),
          languageId: doc.languageId
        });
        if (!decorations || editor !== vscode.window.activeTextEditor) return;

        const decorationOptions: vscode.DecorationOptions[] = decorations.map((d) => ({
          range: new vscode.Range(d.line, 0, d.line, 0),
          hoverMessage: new vscode.MarkdownString(`🌱 **Thymeleaf Companion** : ${d.tooltip}`)
        }));
        editor.setDecorations(gutterDecorationType, decorationOptions);
      } catch {
        // Ignorer si le serveur s'initialise
      }
    }, 250);
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => updateGutter(editor)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (vscode.window.activeTextEditor?.document === e.document) {
        updateGutter(vscode.window.activeTextEditor);
      }
    })
  );

  await languageClient.start();
  updateGutter(vscode.window.activeTextEditor);
}

export async function deactivate(): Promise<void> {
  await languageClient?.stop();
}
