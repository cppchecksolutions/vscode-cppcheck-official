import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from "path";
import * as os from "os";
import * as xml2js from 'xml2js';

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

        await runCppcheckOnFileXML(
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

async function runCppcheckOnFileXML(
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
    // TODO: Reimplement severity filtering
    const minSevNum = parseMinSeverity(minSevString);
    const standardArg = standard !== "<none>" ? `--std=${standard}` : "";

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
        '--xml',
        '--xml-version=2',
        standardArg,
        ...extraArgsParsed,
        filePath.replace(/\\/g, '/')
    ].filter(Boolean);

    const proc = cp.spawn(commandPath, args);

    let xmlOutput = "";
    proc.stderr.on("data", d => xmlOutput += d.toString());
    proc.on("close", () => {
        const parser = new xml2js.Parser({ explicitArray: true });
        parser.parseString(xmlOutput, (err, result) => {
            if (err) {
                console.error("XML parse error:", err);
                return;
            }

            const errors = result.results?.errors?.[0]?.error || [];
            const diagnostics: vscode.Diagnostic[] = [];

            for (const e of errors) {
                const locations = e.location || [];
                if (!locations.length) {
                    continue;
                }

                const mainLoc = locations[locations.length - 1].$;
                const line = Number(mainLoc.line) - 1;
                if (isNaN(line) || line < 0 || line >= document.lineCount) {
                    continue;
                }

                const severity = parseSeverity(e.$.severity);
                const range = new vscode.Range(line, 0, line, document.lineAt(line).text.length);
                const diagnostic = new vscode.Diagnostic(range, `cppcheck: ${e.$.msg}`, severity);
                diagnostic.source = "cppcheck";
                diagnostic.code = e.$.id;

                // Related Information
                const relatedInfos: vscode.DiagnosticRelatedInformation[] = [];
                for (let i = 0; i < locations.length; i++) {
                    const loc = locations[i].$;
                    const msg = loc.info;
                    const lLine = Number(loc.line) - 1;

                    if (msg === null || msg === undefined || isNaN(lLine) || lLine < 0 || lLine >= document.lineCount) {
                        continue;
                    }

                    const relatedRange = new vscode.Range(
                        lLine, 0,
                        lLine, document.lineAt(lLine).text.length
                    );

                    relatedInfos.push(
                        new vscode.DiagnosticRelatedInformation(
                            new vscode.Location(document.uri, relatedRange),
                            msg
                        )
                    );
                }
                if (relatedInfos.length > 0) {
                    diagnostic.relatedInformation = relatedInfos;
                }
                diagnostics.push(diagnostic);
            }
            diagnosticCollection.set(document.uri, diagnostics);
        });
    });
}

// This method is called when your extension is deactivated
export function deactivate() {}