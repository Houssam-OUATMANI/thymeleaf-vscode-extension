import { strict as assert } from "node:assert";
import { fork, ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

test("starts the language server and indexes its workspace after initialization", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "thymeleaf-server-startup-"));
  const serverPath = path.resolve(__dirname, "../server/server.js");
  const server = fork(serverPath, ["--node-ipc"], {
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"]
  });
  let stderr = "";
  server.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    await waitForWorkspaceIndex(server, pathToFileURL(workspace).toString(), () => stderr);
  } finally {
    stopServer(server);
    await rm(workspace, { recursive: true, force: true });
  }
});

function waitForWorkspaceIndex(
  server: ChildProcess,
  workspaceUri: string,
  getStderr: () => string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      finish(new Error(`Language server did not index the workspace. ${getStderr()}`));
    }, 8000);

    const finish = (error?: Error): void => {
      clearTimeout(timeout);
      server.off("message", handleMessage);
      server.off("exit", handleExit);
      if (error) reject(error);
      else resolve();
    };

    const handleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new Error(
        `Language server exited before indexing the workspace (code ${code}, signal ${signal}). ${getStderr()}`
      ));
    };

    const handleMessage = (message: unknown): void => {
      if (!isRecord(message)) return;

      if (message.method === "client/registerCapability" && message.id !== undefined) {
        server.send({ jsonrpc: "2.0", id: message.id, result: null });
        return;
      }

      if (message.id === 1) {
        assert.equal(message.error, undefined, JSON.stringify(message.error));
        server.send({ jsonrpc: "2.0", method: "initialized", params: {} });
      }

      if (message.method === "thymeleaf/javaTypeReferences") finish();
    };

    server.on("message", handleMessage);
    server.once("exit", handleExit);
    server.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        processId: process.pid,
        rootUri: workspaceUri,
        capabilities: { workspace: { workspaceFolders: true } },
        workspaceFolders: [{ uri: workspaceUri, name: "startup-test" }]
      }
    });
  });
}

function stopServer(server: ChildProcess): void {
  if (server.connected) server.disconnect();
  if (server.exitCode === null && server.signalCode === null) server.kill();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
