// B4mal VS Code Extension
// Wraps the built-in LSP server for editor diagnostics.

const vscode = require("vscode");
const { exec } = require("child_process");

/** @param {vscode.ExtensionContext} context */
function activate(context) {
    const checkCommand = vscode.commands.registerCommand("b4mal.check", () => {
        const terminal = vscode.window.createTerminal("B4mal Check");
        terminal.sendText("b4mal check");
        terminal.show();
    });

    const buildCommand = vscode.commands.registerCommand("b4mal.build", () => {
        const terminal = vscode.window.createTerminal("B4mal Build");
        terminal.sendText("b4mal build");
        terminal.show();
    });

    context.subscriptions.push(checkCommand, buildCommand);

    vscode.window.showInformationMessage("B4mal extension activated. Run 'B4mal: Check DAG Correctness' from the command palette.");
}

function deactivate() {}

module.exports = { activate, deactivate };
