import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { randomUUID } from 'crypto';

enum SeverityNumber {
    Info = 0,
    Warning = 1,
    Error = 2
}

function parseSeverity(str: string): vscode.DiagnosticSeverity {
    const lower = str.toLowerCase();
    if (lower.includes("error")) {
        return vscode.DiagnosticSeverity.Error;
    } else if (lower.includes("warning")) {
        return vscode.DiagnosticSeverity.Warning;
    } else {
        return vscode.DiagnosticSeverity.Information;
    }
}

function severityToNumber(sev: vscode.DiagnosticSeverity): SeverityNumber {
    switch (sev) {
        case vscode.DiagnosticSeverity.Error: return SeverityNumber.Error;
        case vscode.DiagnosticSeverity.Warning: return SeverityNumber.Warning;
        default: return SeverityNumber.Info;
    }
}

function parseMinSeverity(str: string): SeverityNumber {
    switch (str.toLowerCase()) {
        case "error": return SeverityNumber.Error;
        case "warning": return SeverityNumber.Warning;
        default: return SeverityNumber.Info;
    }
}

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

// This method is called when your extension is activated.
// Your extension is activated the very first time the command is executed.
export function activate(context: vscode.ExtensionContext) {

    // Create a diagnostic collection.
    const diagnosticCollection = vscode.languages.createDiagnosticCollection("Cppcheck");
    context.subscriptions.push(diagnosticCollection);
    
    // set up a map of timers per document URI for debounce for continuous analysis triggers
    // I.e. document has been changed -> DEBOUNCE_MS time passed since last change -> run cppcheck
    const debounceTimers: Map<string, NodeJS.Timeout> = new Map();
    const DEBOUNCE_MS = 1000;

    async function handleDocument(document: vscode.TextDocument) {
        // Only process C/C++ files.
        if (!["c", "cpp"].includes(document.languageId)) {
            // Not a C/C++ file, skip
            return;
        }

        // Check if the document is visible in any editor
        const isVisible = vscode.window.visibleTextEditors.some(editor => editor.document.uri.toString() === document.uri.toString());
        if (!isVisible) {
            // Document is not visible, skip
            return;
        }

        const config = vscode.workspace.getConfiguration();
        const isEnabled = config.get<boolean>("cppcheck-vscode.enable", true);
        const extraArgs = config.get<string>("cppcheck-vscode.arguments", "");
        const minSevString = config.get<string>("cppcheck-vscode.minSeverity", "info");
        const standard = config.get<string>("cppcheck-vscode.standard", "c++17");
        const userPath = config.get<string>("cppcheck-vscode.path")?.trim() || "";
        const commandPath = userPath ? resolvePath(userPath) : "cppcheck";

        // If disabled, clear any existing diagnostics for this doc.
        if (!isEnabled) {
            diagnosticCollection.delete(document.uri);
            return;
        }

        // Check if cppcheck is available
        cp.exec(`"${commandPath}" --version`, (error) => {
            if (error) {
                vscode.window.showErrorMessage(
                    `Cppcheck: Could not find or run '${commandPath}'. ` +
                    `Please install cppcheck or set 'cppcheck-vscode.path' correctly.`
                );
                return;
            }
        });

        await runCppcheckOnFile(
            document,
            commandPath,
            extraArgs,
            minSevString,
            standard,
            diagnosticCollection
        );
    }

    async function handleDocumentContinuous(e: vscode.TextDocumentChangeEvent) {
        const document : vscode.TextDocument = e.document;
        const uriKey = document.uri.toString();

        // clear any existing timer for this document
        if (debounceTimers.has(uriKey)) {
            clearTimeout(debounceTimers.get(uriKey)!);
        }

        // schedule a new run
        const timer = setTimeout(async () => {
            debounceTimers.delete(uriKey);
            await handleDocument(document);
        }, DEBOUNCE_MS);
        debounceTimers.set(uriKey, timer);
    }

    // Run cppcheck when document is changed, with debounce
    // vscode.workspace.onDidChangeTextDocument(handleDocumentContinuous, null, context.subscriptions);

    // Listen for file saves.
    vscode.workspace.onDidSaveTextDocument(handleDocument, null, context.subscriptions);

    // Run cppcheck when a file is opened
    vscode.workspace.onDidOpenTextDocument(handleDocument, null, context.subscriptions);

    // Run cppcheck for all open files when the workspace is opened
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
        vscode.workspace.textDocuments.forEach(handleDocument);
    }, null, context.subscriptions);

    // Run cppcheck for all open files at activation (for already opened workspaces)
    vscode.workspace.textDocuments.forEach(handleDocument);

    // Clean up diagnostics when a file is closed
    vscode.workspace.onDidCloseTextDocument((document: vscode.TextDocument) => {
        diagnosticCollection.delete(document.uri);
    }, null, context.subscriptions);
}

// NOTE: This function currently uses temp files since cppcheck will not accept text input.
// This causes issues with paths for preprocessor settings and can thus not currently be used
async function runCppcheckTextBuffer(
    document: vscode.TextDocument,
    commandPath: string,
    extraArgs: string,
    minSevString: string,
    standard: string,
    diagnosticCollection: vscode.DiagnosticCollection
): Promise<void> {
    // Clear existing diagnostics for this file
    diagnosticCollection.delete(document.uri);

    const filePath = document.fileName;
    const minSevNum = parseMinSeverity(minSevString);
    const standardArg = standard !== "<none>" ? `--std=${standard}` : "";

    // Save buffer to temp file, for passing to cppcheck
    const textBuffer = document.getText();
    const tmpPath = path.join(os.tmpdir(), "cppcheck-" + randomUUID() + ".cpp");
    fs.writeFileSync(tmpPath, document.getText(), "utf8");

    // Resolve paths for arguments where applicable
    const extraArgsParsed = (extraArgs.split(" ")).map((arg) => {
        if (arg.startsWith('--project')) {
            const splitArg = arg.split('=');
            return `${splitArg[0]}=${resolvePath(splitArg[1])}`;
        }
        return arg;
    });

    const args = [
        '--enable=all',
        standardArg,
        ...extraArgsParsed,
        tmpPath.replace(/\\/g, '/')
    ].filter(Boolean);
    const proc = cp.spawn(commandPath, args);

    // if spawn fails (e.g. ENOENT or permission denied)
    proc.on("error", (err) => {
        console.error("Failed to start cppcheck:", err);
        vscode.window.showErrorMessage(`Cppcheck failed to start: ${err.message}`);
    });

    proc.stdin.write(textBuffer);
    proc.stdin.end();

    let out = "";
    let err = "";

    proc.stdout.on("data", d => out += d.toString());
    proc.stderr.on("data", d => err += d.toString());
    proc.on("close", code => {
        if (code && code > 1) {
            // Non-zero code means an error has occured
            console.error(`cppcheck exited with code ${code}`, err, out);
            vscode.window.showErrorMessage(`${err.trim()} ${out.trim()}`);
        } else {
            const diagnostics: vscode.Diagnostic[] = [];
            const regex = /^(.*?):(\d+):(\d+):\s*(error|warning|style|performance|information|info|note):\s*(.*)$/gm;
            let match;
            const allOutput = err + '\n' + out;
            while ((match = regex.exec(allOutput)) !== null) {
                const [, file, lineStr, colStr, severityStr, message] = match;
                const line = parseInt(lineStr, 10) - 1;
                let col = parseInt(colStr, 10) - 1;
                const diagSeverity = parseSeverity(severityStr);
                // Filter out if severity is less than our minimum
                if (severityToNumber(diagSeverity) < minSevNum) {
                    continue;
                }

                // Handles quirk with 'Active checkers' output that is given -1 line number (should prob be handled differently)
                if (line < 0 || line >= document.lineCount) {
                    console.warn(`cppcheck produced diagnostic for out-of-range line ${line + 1}`);
                    continue;
                }

                // clamp column into valid range for that line
                const lineText = document.lineAt(line).text;
                if (isNaN(col) || col < 0) {
                    col = 0;
                }
                if (col > lineText.length) {
                    col = Math.max(0, lineText.length - 1);
                }
                // produce an end column that covers at least one character (avoids zero-length nonsense)
                const endCol = Math.min(lineText.length, col + 1);

                const range = new vscode.Range(line, col, line, endCol);
                const diagnostic = new vscode.Diagnostic(range, message, diagSeverity);

                diagnostic.code = standard !== "<none>" ? standard : "";
                diagnostic.source = "cppcheck";

                diagnostics.push(diagnostic);
            }
            diagnosticCollection.set(document.uri, diagnostics);
        }
        // Clean up temp file
        fs.unlink(tmpPath, () => {});
    });
}

async function runCppcheckOnFile(
    document: vscode.TextDocument,
    commandPath: string,
    extraArgs: string,
    minSevString: string,
    standard: string,
    diagnosticCollection: vscode.DiagnosticCollection
): Promise<void> {
    // Clear existing diagnostics for this file
    diagnosticCollection.delete(document.uri);

    const filePath = document.fileName;
    const minSevNum = parseMinSeverity(minSevString);
    const standardArg = standard !== "<none>" ? `--std=${standard}` : "";
    const text = document.getText();

    // Resolve paths for arguments where applicable
    const extraArgsParsed = (extraArgs.split(" ")).map((arg) => {
        if (arg.startsWith('--project')) {
            const splitArg = arg.split('=');
            return `${splitArg[0]}=${resolvePath(splitArg[1])}`;
        }
        return arg;
    });

    const args = [
        '--enable=all',
        standardArg,
        ...extraArgsParsed,
        filePath.replace(/\\/g, '/')
    ].filter(Boolean);
    const proc = cp.spawn(commandPath, args);

    // if spawn fails (e.g. ENOENT or permission denied)
    proc.on("error", (err) => {
        console.error("Failed to start cppcheck:", err);
        vscode.window.showErrorMessage(`Cppcheck failed to start: ${err.message}`);
    });

    proc.stdin.write(text);
    proc.stdin.end();

    let out = "";
    let err = "";

    proc.stdout.on("data", d => out += d.toString());
    proc.stderr.on("data", d => err += d.toString());
    proc.on("close", code => {
        if (code && code > 1) {
            // Non-zero code means an error has occured
            console.error(`cppcheck exited with code ${code}`, err, out);
            vscode.window.showErrorMessage(`${err.trim()} ${out.trim()}`);
        } else {
            const diagnostics: vscode.Diagnostic[] = [];
            const regex = /^(.*?):(\d+):(\d+):\s*(error|warning|style|performance|information|info|note):\s*(.*)$/gm;
            let match;
            const allOutput = err + '\n' + out;
            while ((match = regex.exec(allOutput)) !== null) {
                const [, file, lineStr, colStr, severityStr, message] = match;
                const line = parseInt(lineStr, 10) - 1;
                let col = parseInt(colStr, 10) - 1;
                const diagSeverity = parseSeverity(severityStr);
                // Filter out if severity is less than our minimum
                if (severityToNumber(diagSeverity) < minSevNum) {
                    continue;
                }

                // Handles quirk with 'Active checkers' output that is given -1 line number (should prob be handled differently)
                if (line < 0 || line >= document.lineCount) {
                    console.warn(`cppcheck produced diagnostic for out-of-range line ${line + 1}`);
                    continue;
                }

                // clamp column into valid range for that line
                const lineText = document.lineAt(line).text;
                if (isNaN(col) || col < 0) {
                    col = 0;
                }
                if (col > lineText.length) {
                    col = Math.max(0, lineText.length - 1);
                }
                // produce an end column that covers at least one character (avoids zero-length nonsense)
                const endCol = Math.min(lineText.length, col + 1);

                const range = new vscode.Range(line, col, line, endCol);
                const diagnostic = new vscode.Diagnostic(range, message, diagSeverity);

                diagnostic.code = standard !== "<none>" ? standard : "";
                diagnostic.source = "cppcheck";

                diagnostics.push(diagnostic);
            }
            diagnosticCollection.set(document.uri, diagnostics);
        }
    });
}

// This method is called when your extension is deactivated
export function deactivate() {}