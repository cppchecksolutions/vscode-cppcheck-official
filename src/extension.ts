import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as xml2js from 'xml2js';
import * as crypto from 'crypto';

import { documentationLinkMap, getPremiumCertLink } from './util/documentation';
import { runCommand } from './util/scripts';
import { looksLikePath, resolvePath, findWorkspaceRoot } from './util/path';

// To keep track of document changes we save hashed versions of their content to this record
let documentHashMemory : Record<string, string> = {};
// To keep track of warnings for files created from analysis of other files we save their relations to fileRelationMap
let fileRelationMap: Record<string, Set<string>> = {};

let previewAnalysisTimer: NodeJS.Timeout | undefined;
let previewedDocument: vscode.TextDocument | undefined;
let cppcheckProgressIndicator: vscode.StatusBarItem;
let checksRunning = false;

enum SeverityNumber {
    Info = 0,
    Warning = 1,
    Error = 2
}

const criticalWarningTypes = [
    'cppcheckError',
    'cppcheckLimit',
    'includeNestedTooDeeply',
    'internalAstError',
    'instantiationError',
    'internalError',
    'missingFile',
    'premium-internalError',
    'premium-invalidArgument',
    'premium-invalidLicense',
    'preprocessorErrorDirective',
    'syntaxError',
    'unhandledChar',
    'unknownMacro'
];

const pathVariableArgs = [
    '--project',
    '--addon',
    '--suppressions-list',
    '--include',
    '--rule-file',
];

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

function updateProgressIndicator(): void {
	if (checksRunning) {
		cppcheckProgressIndicator.text = `$(loading~spin) Cppcheck Running ..`;
		cppcheckProgressIndicator.show();
	} else {
		cppcheckProgressIndicator.hide();
	}
}

function getDocumentSha1(document: vscode.TextDocument): string {
    return crypto
        .createHash('sha1')
        .update(document.getText(), 'utf8')
        .digest('hex');
}

// This method is called when your extension is activated.
// Your extension is activated the very first time the command is executed.
export async function activate(context: vscode.ExtensionContext) {

    // Register a command to push user to workspace settings from walkthrough
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'cppcheck-official.configureArguments',
            async () => {
                await vscode.commands.executeCommand(
                    'workbench.action.openWorkspaceSettings',
                    'cppcheck-official.arguments'
                );
            }
        )
    );

    // ProgressIndicator status bar item to show when checks are running
	cppcheckProgressIndicator = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
	context.subscriptions.push(cppcheckProgressIndicator);

    // Create a diagnostic collection.
    const diagnosticCollection = vscode.languages.createDiagnosticCollection("Cppcheck");
    context.subscriptions.push(diagnosticCollection);

    function clearDiagnosticForDoc(doc: vscode.TextDocument): void {
        // Any file who was warnings generated from (and only from) the closed doc have their diagnostics cleared
        // NOTE: This includes the closed doc - its diagnostics will only be cleared if its warnings only come from analysis of it itself
        for (const fileUri of Object.keys(fileRelationMap)) {
            if (fileRelationMap[fileUri].has(doc.uri.toString())) {
                if (fileRelationMap[fileUri].size <= 1) {
                    diagnosticCollection.delete(vscode.Uri.parse(fileUri));
                    fileRelationMap[fileUri].clear();
                } else {
                    fileRelationMap[fileUri].delete(doc.uri.toString());
                }
            }
        }
        documentHashMemory[doc.fileName] = '';
    }

    async function handleDocument(document: vscode.TextDocument) {
        // Only process C/C++ files.
        if (!["c", "cpp"].includes(document.languageId)) {
            // Not a C/C++ file, skip
            return;
        }

        if ((Object.keys(documentHashMemory) as Array<string>).includes(document.fileName)) {
            // Check file content against memory, if it has not changed since last check do early return
            const newHash = getDocumentSha1(document);
            const oldHash = documentHashMemory[document.fileName];
            if (newHash === oldHash) {
                return;
            }
        }

        // Check if the document is visible in any editor
        const isVisible = vscode.window.visibleTextEditors.some(editor =>
            editor.document.uri.toString().replaceAll('\\', '/') === document.uri.toString().replaceAll('\\', '/'));
        if (!isVisible) {
            // Document is not visible, skip
            return;
        }

        const config = vscode.workspace.getConfiguration();
        const isEnabled = config.get<boolean>("cppcheck-official.enable", true);
        const minSevString = config.get<string>("cppcheck-official.minSeverity", "info");
        const userPath = config.get<string>("cppcheck-official.path")?.trim() || "";
        const commandPath = userPath ? resolvePath(userPath) : "cppcheck";

        var  args = config.get<string>("cppcheck-official.arguments", "");
        // If user enter arguments as array we parse them into space separated string format
        if (args.startsWith("[") && args.endsWith("]")) {
            args = args.replaceAll("[", "").replaceAll("]", "").replaceAll(",", " ");
        }
        
        var processedArgs = '';
        // If argument field contains command to run script we do so here
        if (args.includes('@(')) {
            const scriptCommand = args.split("@(")[1].split(")")[0];
            const scriptOutput = await runCommand(scriptCommand);
            // We expect that the script output that is to be used as arguments will be wrapped with ${}
            const scriptOutputTrimmed = scriptOutput.split("@(")[1].split(")")[0];
            processedArgs = args.split("@(")[0] + scriptOutputTrimmed + args.split(")")?.[1];
        } else {
            processedArgs = args;
        }

        // If disabled, clear any existing diagnostics for this doc.
        if (!isEnabled) {
            clearDiagnosticForDoc(document);
            return;
        }

        // Check if cppcheck is available
        cp.exec(`"${commandPath}" --version`, (error) => {
            if (error) {
                vscode.window.showErrorMessage(
                    `Cppcheck: Could not find or run '${commandPath}'. ` +
                    `Please install cppcheck or set 'cppcheck-official.path' correctly.`
                );
                return;
            }
        });

        await runCppcheckOnFileXML(
            document,
            commandPath,
            processedArgs,
            minSevString,
            diagnosticCollection
        );
    }

    // Listen for file saves.
    vscode.workspace.onDidSaveTextDocument(handleDocument, null, context.subscriptions);

    // Run cppcheck when a file is opened
    vscode.workspace.onDidOpenTextDocument(handleDocument, null, context.subscriptions);

    // Run cppcheck when changing files viewed in text editor
    vscode.window.tabGroups.onDidChangeTabs(async e => {
        clearTimeout(previewAnalysisTimer);
        for (const tab of e.changed) {
            if (tab.input instanceof vscode.TabInputText) {
                const uri = tab.input.uri;
                const document =
                    vscode.workspace.textDocuments.find(
                        doc => doc.uri.toString() === uri.toString()
                    ) ?? await vscode.workspace.openTextDocument(uri);
                // Only analyze previewed files if user stays on them for 10 seconds
                if (tab && tab.isPreview) {
                    previewAnalysisTimer = setTimeout(() => {
                        handleDocument(document);
                        previewedDocument = document;
                    }, 10000);
                } else {
                    // If file is properly opened we run analysis right away
                    handleDocument(document);
                }
            }
        }
        for (const tab of e.closed) {
            if (tab.input instanceof vscode.TabInputText) {
                const uri = tab.input.uri;
                const document =
                    vscode.workspace.textDocuments.find(
                        doc => doc.uri.toString() === uri.toString()
                    ) ?? await vscode.workspace.openTextDocument(uri);
                clearDiagnosticForDoc(document);
            }
        }
    }, null, context.subscriptions);

    // Clear diagnostics of previewed files when no longer viewed
    vscode.window.onDidChangeActiveTextEditor(() => {
        if (previewedDocument) {
            clearDiagnosticForDoc(previewedDocument);
            previewedDocument = undefined;
        }
    });

    // Run cppcheck for all open files when the workspace is opened
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
        vscode.workspace.textDocuments.forEach(handleDocument);
    }, null, context.subscriptions);

    // Run cppcheck for all open files at activation (for already opened workspaces)
    vscode.workspace.textDocuments.forEach(handleDocument);

    // Clean up diagnostics when a file is closed
    vscode.workspace.onDidCloseTextDocument((document: vscode.TextDocument) => {
        clearDiagnosticForDoc(document);
    }, null, context.subscriptions);
}

async function runCppcheckOnFileXML(
    document: vscode.TextDocument,
    commandPath: string,
    processedArgs: string,
    minSevString: string,
    diagnosticCollection: vscode.DiagnosticCollection
): Promise<void> {
    checksRunning = true;
    updateProgressIndicator();

    // Clear existing diagnostics for this file
    diagnosticCollection.delete(document.uri);

    // Replace backslashes (used in paths in Windows environment)
    const filePath = document.fileName.replaceAll('\\', '/');
    const minSevNum = parseMinSeverity(minSevString);

    // Resolve paths for arguments where applicable
    const argsParsed = processedArgs.split(" ").map((arg) => {
        let cleanedArg = arg.replaceAll("\"","");
        const isPathArgument = pathVariableArgs.some(a => cleanedArg.startsWith(a));
        // Some arguments such as addon may be either a path or the name of a built in addon
        if (isPathArgument && looksLikePath(cleanedArg)) {
            const splitArg = cleanedArg.split('=');
            return `${splitArg[0]}=${resolvePath(splitArg[1])}`;
        }
        return arg;
    });

    let usingProjectFile = false;
    const args = [
        '--enable=all',
        '--inline-suppr',
        '--xml',
        '--suppress=unusedFunction',
        '--suppress=missingInclude',
        '--suppress=missingIncludeSystem',
        ...argsParsed,
    ].filter(Boolean);
    if (processedArgs.includes("--project")) {
        usingProjectFile = true;
        args.push(`--file-filter=${filePath}`);
    } else {
        args.push(filePath);
    }

    let proc;
    const cwd = findWorkspaceRoot();
    proc = cp.spawn(commandPath, args, {
        cwd,
    });

    // if spawn fails (e.g. ENOENT or permission denied)
    proc.on("error", (err) => {
        console.error("Failed to start cppcheck:", err);
        vscode.window.showErrorMessage(`Cppcheck failed to start: ${err.message}`);
    });

    let xmlOutput = "";
    let out = "";
    proc.stderr.on("data", d => xmlOutput += d.toString());
    proc.stdout.on("data", d => out += d.toString());
    proc.on("close", code => {
        if (code && code > 0) {
            // Non-zero code means an error has occured
            let errorMessage = `Cppcheck failed with code ${code} (unknown error)`;
            if (out.trim().length > 0) {
                errorMessage = out.trim();
            }
            errorMessage = `${errorMessage}, Command: ${commandPath} ${args.join(' ')}`;
            vscode.window.showErrorMessage(errorMessage);
        }
        const parser = new xml2js.Parser({ explicitArray: true });
        parser.parseString(xmlOutput, async (err, result) => {
            if (err) {
                console.error("XML parse error:", err);
                return;
            }

            const errors = result.results?.errors?.[0]?.error || [];
            const diagnostics: Record<string, vscode.Diagnostic[]> = {};

            for (const e of errors) {
                const isCriticalError = criticalWarningTypes.includes(e.$.id);
                const locations = e.location || [];
                if (!locations.length) {
                    continue;
                }

                const mainLoc = locations[locations.length - 1].$;
                
                // If main location is not current file, we are not using a project file and warning is not critical then skip displaying warning
                if (!isCriticalError && usingProjectFile && !filePath.endsWith(mainLoc.file)) {
                    continue;
                }

                // Cppcheck line number is 1-indexed, while VS Code uses 0-indexing
                let line = Number(mainLoc.line) - 1;
                // Invalid line number usually means non-analysis output 
                if (isNaN(line) || line < 0 || line >= document.lineCount) {
                    if (isCriticalError) {
                        line = 0;
                    } else {
                        continue;
                    }
                }

                // Cppcheck col number is 1-indexed, while VS Code uses 0-indexing
                let col = Number(mainLoc.column) - 1;
                if (isNaN(col) || col < 0 || col > document.lineAt(line).text.length) {
                    col = 0;
                }

                const severity = parseSeverity(e.$.severity);
                if (!isCriticalError && severityToNumber(severity) < minSevNum) {
                    continue;
                }

                const range = new vscode.Range(line, col, line, document.lineAt(line).text.length);
                const diagnostic = new vscode.Diagnostic(range, e.$.msg, severity);
                diagnostic.source = "cppcheck";
                // If we have a link to documentation, include it
                diagnostic.code = documentationLinkMap[e.$.id] ? {
                    value: e.$.id,
                    target: vscode.Uri.parse(documentationLinkMap[e.$.id])
                } : getPremiumCertLink(e.$.id) ? {
                    value: e.$.id,
                    target: vscode.Uri.parse(getPremiumCertLink(e.$.id))
                } : e.$.id;

                // Related Information
                const relatedInfos: vscode.DiagnosticRelatedInformation[] = [];
                for (let i = 1; i <= locations.length; i++) {
                    // Related information is ordered in reverse in XML object
                    const loc = locations[locations.length - i].$;
                    const msg = loc.info;
                    const lLine = Number(loc.line) - 1;
                    const lCol = Number(loc.col) - 1;

                    if (msg === null || msg === undefined || isNaN(lLine) || lLine < 0 || lLine >= document.lineCount) {
                        continue;
                    }

                    const relatedRange = new vscode.Range(
                        lLine, lCol,
                        lLine, document.lineAt(lLine).text.length
                    );
                    const relatedDocument = await vscode.workspace.openTextDocument(loc.file);
                    relatedInfos.push(
                        new vscode.DiagnosticRelatedInformation(
                            new vscode.Location(relatedDocument?.uri ?? '', relatedRange),
                            msg
                        )
                    );
                }
                if (relatedInfos.length > 0) {
                    diagnostic.relatedInformation = relatedInfos;
                }
                const diagnosticFile = mainLoc.file;
                if (diagnosticFile === document.fileName) {
                    const uri = document.uri.toString();
                    if (diagnostics[uri] === null || diagnostics[uri] === undefined) {
                        diagnostics[uri] = [];
                    }
                    diagnostics[uri].push(diagnostic);
                } else {
                    const relatedDocument = await vscode.workspace.openTextDocument(mainLoc.file);
                    const uri = relatedDocument.uri.toString();
                    if (diagnostics[uri] === null || diagnostics[uri] === undefined) {
                        diagnostics[uri] = [];
                    }
                    diagnostics[uri].push(diagnostic);
                }
            }
            const sourceDocumentUri = document.uri.toString();
            for (const uri of Object.keys(diagnostics)) {
                diagnosticCollection.set(vscode.Uri.parse(uri), diagnostics[uri]);
                if (fileRelationMap[uri] === null ||fileRelationMap[uri] === undefined) {
                    fileRelationMap[uri] = new Set;
                }
                // NOTE: uri can be the same as sourceDocumentUri
                fileRelationMap[uri].add(sourceDocumentUri);
            }
        });

        // If checks have run without error, save hashed document content to memory
        if (!code) {
            const hashedContentOfFile = getDocumentSha1(document);
            documentHashMemory[document.fileName] = hashedContentOfFile;
        }
    });

    checksRunning = false;
    updateProgressIndicator();
}

// This method is called when your extension is deactivated
export function deactivate() {}
