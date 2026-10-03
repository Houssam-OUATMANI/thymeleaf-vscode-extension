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
  await languageClient.start();
}

export async function deactivate(): Promise<void> {
  await languageClient?.stop();
}
