import * as path from "path";
import * as os from "os";
import * as vscode from 'vscode';

const pathVariableArgs = [
    '--project',
    '--addon',
    '--suppressions-list',
    '--include',
    '--rule-file',
];

export function splitArgsAndResolvePaths(args: string) : Array<string> {
    const result = args.split(" ").map((arg) => {
        let cleanedArg = arg.replaceAll("\"","");
        const isPathArgument = pathVariableArgs.some(a => cleanedArg.startsWith(a));
        // Some arguments such as addon may be either a path or the name of a built in addon
        if (isPathArgument && looksLikePath(cleanedArg)) {
            const splitArg = cleanedArg.split('=');
            return `${splitArg[0]}=${resolvePath(splitArg[1])}`;
        }
        return arg;
    });
    return result;
}

export function looksLikePath(arg: string): boolean {
    if (
        arg.includes('/')
        || arg.includes('\\')
        || arg.startsWith('.')
        || /\.[^/\\]+$/.test(arg) // filename with extension
    ) {
        return true;
    }
    return false;
}

export function findWorkspaceRoot(): string {
    const folders = vscode.workspace.workspaceFolders;
    const workspaceRoot = folders && folders.length > 0
        ? folders[0].uri.fsPath
        : process.cwd();
    return workspaceRoot;
}

export function resolvePath(argPath: string): string {
    const workspaceRoot = findWorkspaceRoot();

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