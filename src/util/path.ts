import * as path from "path";
import * as os from "os";
import * as vscode from 'vscode';

export function resolvePath(argPath: string): string {
    const folders = vscode.workspace.workspaceFolders;
    const workspaceRoot = folders && folders.length > 0
        ? folders[0].uri.fsPath
        : process.cwd();

    // Expand ${workspaceFolder}
    if (argPath.includes("${workspaceFolder}")) {
        argPath = argPath.replace("${workspaceFolder}", workspaceRoot);
    }

    // Expand tilde (~) to home directory
    if (argPath.startsWith("~")) {
        argPath = path.join(os.homedir(), argPath.slice(1));
    }

    // Expand ./ or ../ relative paths (relative to workspace root if available)
    if (argPath.startsWith("./") || argPath.startsWith("../")) {
        argPath = path.resolve(workspaceRoot, argPath);
    }

    // If still not absolute, treat it as relative to workspace root
    if (!path.isAbsolute(argPath)) {
        argPath = path.join(workspaceRoot, argPath);
    }
    return argPath;
}