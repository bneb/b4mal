// B4mal VS Code Extension — activates the LSP for b4mal config files
const vscode = require("vscode");
const { spawn } = require("child_process");

/** @type {vscode.LanguageClient} */
let client;

function activate(context) {
  const b4malPath = vscode.workspace.getConfiguration("b4mal").get("lsp.path", "b4mal");

  const serverOptions = {
    command: b4malPath,
    args: ["lsp"],
  };

  const clientOptions = {
    documentSelector: [
      { scheme: "file", language: "json" },
      { scheme: "file", pattern: "**/b4mal.config.json" },
      { scheme: "file", pattern: "**/b4mal.lock" },
    ],
  };

  client = new vscode.LanguageClient(
    "b4mal-lsp",
    "B4mal Language Server",
    serverOptions,
    clientOptions
  );

  context.subscriptions.push(client.start());
}

function deactivate() {
  if (client) return client.stop();
  return undefined;
}

module.exports = { activate, deactivate };
