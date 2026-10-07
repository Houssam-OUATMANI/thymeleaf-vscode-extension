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
    })
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
