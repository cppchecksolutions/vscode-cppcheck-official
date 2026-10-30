import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as xml2js from 'xml2js';

import { resolvePath, findWorkspaceRoot, splitArgsAndResolvePaths } from './util/path';
import { DiagnosticStore } from './util/diagnosticStore';
import { StatusBar } from './util/statusBar';
import { CodeActionProvider } from './util/codeActions';
import { ProjectFileStore, writeSuppressionToProjectFile, isFileInCompilationDatabase, getCompilationDatabasePath } from './util/files';
import { extractRelatedInformation, setUpDiagnostic, isCriticalWarning } from './helpers/diagnosticHelpers';
import { processArguments, SeverityNumber, parseSeverity, severityToNumber } from './helpers/settingsHelpers';
import { getArguments } from './util/settingsFile';
import { DocumentHashMemory } from './util/documentHash';

let projectFileStore: ProjectFileStore;
let diagnosticStore: DiagnosticStore;
let documentHashMemory: DocumentHashMemory;
let fileRelationMap: Record<string, Set<string>>;
let statusBar: StatusBar;

let previewAnalysisTimer: NodeJS.Timeout | undefined;
let previewedDocument: vscode.TextDocument | undefined;
let cppcheckProgressIndicator: vscode.StatusBarItem;
let severityOption: vscode.StatusBarItem;
let hiddenTypesOption: vscode.StatusBarItem;
let fullAnalysisStatusBarItem: vscode.StatusBarItem;
let usesPremiumCppcheck = false;

function clearFileRelationMap() {
    for (const fileUri of Object.keys(fileRelationMap)) {
        fileRelationMap[fileUri].clear();
    }
}

// This method is called when your extension is activated.
// Your extension is activated the very first time the command is executed.
export async function activate(context: vscode.ExtensionContext) {    
    // Create a diagnostic collection.
    const diagnosticCollection = vscode.languages.createDiagnosticCollection("Cppcheck");
    // Some diagnostics have symbol names associated with them, which we keep track of in diagnosticStore
    diagnosticStore = new DiagnosticStore(diagnosticCollection);
    // To keep track of document changes we save hashed versions of their content to documentHashMemory
    documentHashMemory = new DocumentHashMemory;
    // To keep track of warnings for files created from analysis of other files we save their relations to fileRelationMap
    fileRelationMap = {};
    // The ProjectFileStore is usd to keep track of the users project file through different context
    projectFileStore = new ProjectFileStore();
    statusBar = new StatusBar(projectFileStore);

    context.subscriptions.push(diagnosticCollection);

    // Set up code actions provider
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            { pattern: "**/*" },
            new CodeActionProvider(diagnosticStore, projectFileStore),
            {
                providedCodeActionKinds: [
                    vscode.CodeActionKind.QuickFix
                ]
            }
        )
    );

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
    
    // Register a command to browse for the cppcheck executable, linked from the path setting
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'cppcheck-official.browsePath',
            async () => {
                const config = vscode.workspace.getConfiguration('cppcheck-official');
                const currentPath = config.get<string>('path', '');
                const uris = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: false,
                    title: 'Select the cppcheck executable',
                    openLabel: 'Select',
                    defaultUri: currentPath ? vscode.Uri.file(resolvePath(currentPath)) : undefined,
                    filters: process.platform === 'win32' ? { 'Executables': ['exe'], 'All files': ['*'] } : undefined
                });
                // User cancels the dialog -> uris === undefined
                if (!uris || uris.length === 0) {
                    return;
                }
                await config.update('path', uris[0].fsPath, vscode.ConfigurationTarget.Global);
                const inspected = config.inspect<string>('path');
                if (inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined) {
                    vscode.window.showWarningMessage(
                        `Cppcheck path saved to user settings, but it is overridden by the workspace setting '${inspected.workspaceFolderValue ?? inspected.workspaceValue}'.`
                    );
                }
            }
        )
    );

    // Register a command for suppressing a warning type
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "cppcheck-official.suppressWarningAll",
            async (diagnosticCode : string, file? : string, symbolName? : string) => {
                const projectFileUri = projectFileStore.getUri();
                if (projectFileUri && projectFileStore.hasCppcheckProjectFile()) {
                    const success = await writeSuppressionToProjectFile(projectFileUri, diagnosticCode, file, symbolName);
                    if (success) {
                        // Construct information message to display to the user
                        const fileMessagePart = file ? ` for file ${file}` : ''; 
                        const symbolNameMessagePart = symbolName ? ` for symbol name ${symbolName}` : '';
                        const fileOrSymbolExtraMessage = file || symbolName ? '. Note: you have to re-analyze the file for the suppression to take effect.' : '';
                        const completeInformationMessageText = `Suppression of ${diagnosticCode} added to project file ${projectFileStore.getUri()?.toString()}${fileMessagePart}${symbolNameMessagePart}${fileOrSymbolExtraMessage}`;
                        vscode.window.showInformationMessage(completeInformationMessageText);
                    } else {
                        vscode.window.showErrorMessage(`Failed to add suppression of ${diagnosticCode} to project file ${projectFileStore.getUri()?.toString()}`);
                    }
                } else {
                    throw new Error(`Cppcheck Official error: Command 'cppcheck-official.suppressWarningAll' for project file level suppression called without project file present!`);
                }
            }
        )
    );

    // Register a command for hiding a warning
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "cppcheck-official.hideWarning",
            async (uri : vscode.Uri, diagnosticCode : string, range : vscode.Range) => {
                const diagnostics = diagnosticStore.getByUri(uri);
                diagnostics?.forEach((diagnostic : vscode.Diagnostic) => {
                    var code = diagnostic.code;
                    if (typeof(code) === "object" && typeof(code) !== null) {
                        code = code.value;
                    }
                    if (code === diagnosticCode && diagnostic.range.isEqual(range)) {
                        diagnosticStore.setHidden(diagnostic, true);
                    }
                });
                diagnosticStore.refresh();
            }
        )
    );

    // Register a command for hiding all warnings of a given type
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "cppcheck-official.hideWarningType",
            async (diagnosticCode : string) => {
                diagnosticStore.hideType(diagnosticCode);
                diagnosticStore.refresh();
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "cppcheck-official.suppressWarningAdvanced",
            async (diagnosticCode : string, doc : vscode.TextDocument, diagnostic : vscode.Diagnostic) => {
                const storedSymbolName = diagnosticStore.get(diagnostic)?.symbolName;
                const symbolExistsForDiagnostic = !!storedSymbolName;
                const file = await vscode.window.showInputBox(
                    {
                        value: doc.fileName,
                        title: symbolExistsForDiagnostic 
                        ? "Create Cppcheck Suppression by file and / or symbol (leave blank to skip file filter) (1/2)"
                        : "Create Cppcheck Suppression by file"
                    }
                );
                // User presses ESC -> file === undefined
                if (file === undefined) {
                    return;
                }
                let symbolName = null;
                if (symbolExistsForDiagnostic) {
                    symbolName = await vscode.window.showQuickPick(
                        [
                            {
                                label: `Symbol: ${storedSymbolName}`,
                                value: storedSymbolName
                            },
                            {
                                label: 'Not symbol specific',
                                value: null
                            },
                        ],
                        {
                            title: "Create Cppcheck Suppression by file and / or symbol (2/2)"
                        }
                    );
                    // User presses ESC -> symbolName === undefined
                    if (symbolName === undefined) {
                        return;
                    }
                }
                await vscode.commands.executeCommand('cppcheck-official.suppressWarningAll', diagnosticCode, file, symbolName?.value);
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "cppcheck-official.selectMinSeverity",
            async () => {
                const current = vscode.workspace
                    .getConfiguration("cppcheck-official")
                    .get<string>("minSeverity", "info");

                const selection = await vscode.window.showQuickPick(
                    [
                        {
                            label: "Info",
                            description: current === "info" ? "Cppcheck analysis minimum level: Info" : "",
                            value: "info"
                        },
                        {
                            label: "Warning",
                            description: current === "warning" ? "Cppcheck analysis minimum level: Warning" : "",
                            value: "warning"
                        },
                        {
                            label: "Error",
                            description: current === "error" ? "Cppcheck analysis minimum level: Error" : "",
                            value: "error"
                        }
                    ],
                    {
                        title: "Select Mode"
                    }
                );
                if (!selection) {
                    return;
                }

                await vscode.workspace
                    .getConfiguration("cppcheck-official")
                    .update(
                        "minSeverity",
                        selection.value,
                        vscode.ConfigurationTarget.Workspace
                    );
                    
                // Clear diagnostics below severity level selected from the problems tab
                diagnosticStore.applyMinSeverity(parseSeverity(selection.value));
                diagnosticStore.refresh();
            }
        )
    );
    
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "cppcheck-official.runFullAnalysis",
            async () => {

                const selection = await vscode.window.showQuickPick(
                    [
                        {
                            label: "1 thread",
                            description: "No parallel threads",
                            value: "-j1"
                        },
                        {
                            label: "2 threads",
                            description: "2 parallel threads",
                            value: "-j2"
                        },
                        {
                            label: "4 threads",
                            description: "4 parallel threads",
                            value: "-j4"
                        }
                    ],
                    {
                        title: "Select how many threads to run in parallel for full analysis"
                    }
                );
                if (!selection) {
                    return;
                }

                const config = vscode.workspace.getConfiguration();
                const userPath = config.get<string>("cppcheck-official.path")?.trim() || "";
                const commandPath = userPath ? resolvePath(userPath) : "cppcheck";

                var  args = getArguments(config);
                const processedArgs = await processArguments(args);

                // Check if cppcheck is available
                cp.exec(`"${commandPath}" --version`, (error, stdout) => {
                    if (error) {
                        vscode.window.showErrorMessage(
                            `Cppcheck: Could not find or run '${commandPath}'. ` +
                            `Please install cppcheck or set 'cppcheck-official.path' correctly.`
                        );
                        return;
                    }
                    usesPremiumCppcheck = stdout.toLowerCase().includes('premium'); 
                });

                // Run
                await runFullAnalysis(
                    commandPath,
                    processedArgs,
                    selection.value,
                );

                const minSevString = config.get<string>("cppcheck-official.minSeverity", "info");
                diagnosticStore.applyMinSeverity(parseSeverity(minSevString));
                diagnosticStore.refresh();
                // Analysis in runFullAnalysis populates uriDiagnosticsMap with all warnings, regardless of min severity filter.
                // Thus after running analysis we have to apply the severity filter (this also populates DiagnosticCollection, making the diagnostics visible)
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "cppcheck-official.revealHiddenTypes",
            async () => {
                const currentHiddenTypes = Array.from(diagnosticStore.getHiddenTypes());
                const selection = await vscode.window.showQuickPick(
                    currentHiddenTypes.map((type) => {
                        return {
                            label: type,
                            value: type,
                        };
                    }),
                    {
                        title: "Click to reveal hidden warnings of type"
                    }
                );
                if (!selection) {
                    return;
                }
                diagnosticStore.revealType(selection.value);
                diagnosticStore.refresh();
                statusBar.setHiddenTypesCount(diagnosticStore.hiddenTypeCount);
            }
        )
    );

    // ProgressIndicator status bar item to show when checks are running
	cppcheckProgressIndicator = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
	context.subscriptions.push(cppcheckProgressIndicator);

    // Severity option status bar item
    severityOption = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 9);
    severityOption.command = "cppcheck-official.selectMinSeverity";
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration("cppcheck-official.selectMinSeverity")) {
                statusBar.updateMinSeverity();
            }
        })
    );

    // Call update function once at setup to set the UI text to the settings current value
    statusBar.updateMinSeverity();
    
    // Hidden types option status bar item
    hiddenTypesOption = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 8);
    hiddenTypesOption.command = "cppcheck-official.revealHiddenTypes";
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration("cppcheck-official.revealHiddenTypes")) {
                diagnosticStore.refresh();
            }
        })
    );
    
    // Call update function once at setup to set the UI text to the settings current value
    diagnosticStore.refresh();

    // Full analysis status bar item
    fullAnalysisStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 8);
    fullAnalysisStatusBarItem.command = "cppcheck-official.runFullAnalysis";
    fullAnalysisStatusBarItem.text = `$(play) Full Analysis`;
    // If a project file exists, show full analysis status bar item
    if (projectFileStore.getUri()) {
        fullAnalysisStatusBarItem.show();
    }
    context.subscriptions.push(fullAnalysisStatusBarItem);

    async function handleDocument(document: vscode.TextDocument) {
        // Only process C/C++ files.
        if (!["c", "cpp"].includes(document.languageId)) {
            // Not a C/C++ file, skip
            return;
        }

        if ((Object.keys(documentHashMemory) as Array<string>).includes(document.fileName)) {
            // Check file content against memory, if it has not changed since last check do early return
            if (documentHashMemory.isUnchanged(document)) {
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
        const userPath = config.get<string>("cppcheck-official.path")?.trim() || "";
        const commandPath = userPath ? resolvePath(userPath) : "cppcheck";

        var  args = getArguments(config);
        const processedArgs = await processArguments(args);

        // If disabled, clear any existing diagnostics for this doc.
        if (!isEnabled) {
            diagnosticStore.clearForDocument(document.uri.toString());
            return;
        }

        // Check if cppcheck is available
        cp.exec(`"${commandPath}" --version`, (error, stdout) => {
            if (error) {
                vscode.window.showErrorMessage(
                    `Cppcheck: Could not find or run '${commandPath}'. ` +
                    `Please install cppcheck or set 'cppcheck-official.path' correctly.`
                );
                return;
            }
            usesPremiumCppcheck = stdout.toLowerCase().includes('premium'); 
        });

        await runCppcheckOnFileXML(
            document,
            commandPath,
            processedArgs,
        );

        // Analysis in runCppcheckOnFileXML populates uriDiagnosticsMap with all warnings, regardless of min severity filter.
        // Thus after running analysis we have to apply the severity filter (this also populates DiagnosticCollection, making the diagnostics visible)
        const minSevString = config.get<string>("cppcheck-official.minSeverity", "info");
        diagnosticStore.applyMinSeverity(parseSeverity(minSevString));
        diagnosticStore.refresh();
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
                diagnosticStore.clearForDocument(document.uri.toString());
            }
        }
    }, null, context.subscriptions);

    // Clear diagnostics of previewed files when no longer viewed
    vscode.window.onDidChangeActiveTextEditor(() => {
        if (previewedDocument) {
            diagnosticStore.clearForDocument(previewedDocument.uri.toString());
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
        diagnosticStore.clearForDocument(document.uri.toString());
    }, null, context.subscriptions);
}

async function runCppcheckOnFileXML(
    document: vscode.TextDocument,
    commandPath: string,
    processedArgs: string,
): Promise<void> {
    statusBar.setRunning(true);

    // Replace backslashes (used in paths in Windows environment)
    const filePath = document.fileName.replaceAll('\\', '/');
    
    // We always call cppcheck with severity level info, and then filter warnings when displaying them
    const minSevNum = SeverityNumber.Info;

    // Resolve paths for arguments where applicable
    const argsParsed = splitArgsAndResolvePaths(processedArgs);
    
    const args = [
        '--enable=all',
        '--inline-suppr',
        '--xml',
        ...argsParsed,
    ].filter(Boolean);
    
    if (usesPremiumCppcheck) {
        args.push('--premium=safety-off');
    }
    
    let usingProjectFile = false;
    if (processedArgs.includes("--project=")) {
        const projectFileArgument = argsParsed.find((a) => a.includes('--project=')) ?? '';
        var projectFilePath = projectFileArgument.split('--project=')[1];
        const absoluteProjectFilePath = resolvePath(projectFilePath);

        var compilationDbPath;
        if (absoluteProjectFilePath.endsWith('.json')) {
            compilationDbPath = absoluteProjectFilePath;
        } else if (absoluteProjectFilePath.endsWith('.cppcheck')) {
            compilationDbPath = await getCompilationDatabasePath(absoluteProjectFilePath);
        }

        if (compilationDbPath) {
            const inCompilationDb = await isFileInCompilationDatabase(compilationDbPath, document.fileName);
            if (!inCompilationDb) {
                // Not a translation unit of the project (e.g. a header), nothing to analyze on its own
                statusBar.setRunning(false);
                return;
            }
        }
        usingProjectFile = true;
        args.push(`--file-filter=${filePath}`);
        projectFileStore.setUri(vscode.Uri.file(absoluteProjectFilePath));
    } else {
        projectFileStore.clear();
        args.push(
        '--suppress=unusedFunction',
        '--suppress=missingInclude',
        '--suppress=missingIncludeSystem');
        args.push(filePath);
    }

    // Clear existing diagnostics for this file
    diagnosticStore.clearForDocument(document.uri.toString());

    let proc;
    const cwd = findWorkspaceRoot();
    proc = cp.spawn(commandPath, args, {
        cwd,
    });

    await new Promise<void>((resolve, reject) => {
        // if spawn fails (e.g. ENOENT or permission denied)
        proc.on("error", (err) => {
            console.error("Failed to start cppcheck:", err);
            vscode.window.showErrorMessage(`Cppcheck failed to start: ${err.message}`);
            reject(err);
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

                const errors = result?.results?.errors?.[0]?.error || [];
                const diagnostics: Record<string, vscode.Diagnostic[]> = {};
                for (const e of errors) {
                    const locations = e.location || [];
                    if (!locations.length) {
                        continue;
                    }

                    const mainLoc = locations[locations.length - 1].$;
                    // If main location is not current file, we are not using a project file and warning is not critical then skip displaying warning
                    if (!isCriticalWarning(e.$.id) && usingProjectFile && !filePath.endsWith(mainLoc.file)) {
                        continue;
                    }

                    let mainLocDocument : vscode.TextDocument | undefined;
                    try {
                        mainLocDocument = await vscode.workspace.openTextDocument(mainLoc.file);
                    } catch {
                        // do nothing
                    }

                    // Cppcheck line number is 1-indexed, while VS Code uses 0-indexing
                    let line = Number(mainLoc.line) - 1;
                    // Invalid line number usually means non-analysis output 
                    if (isNaN(line) || line < 0 || line >= document.lineCount) {
                        if (isCriticalWarning(e.$.id)) {
                            line = 0;
                        } else {
                            continue;
                        }
                    }

                    // Cppcheck col number is 1-indexed, while VS Code uses 0-indexing
                    let col = Number(mainLoc.column) - 1;
                    if (isNaN(col) || col < 0 || !mainLocDocument || col > mainLocDocument.lineAt(line).text.length) {
                        col = 0;
                    }

                    const severity = parseSeverity(e.$.severity);
                    if (!isCriticalWarning(e.$.id) && severityToNumber(severity) < minSevNum) {
                        continue;
                    }

                    // If warning has a symbol we keep track of it
                    const symbolName = e.symbol?.[0] ?? '';
                    // Save line of code at main location if we can access it
                    const mainLocLine = mainLocDocument?.lineAt(line)?.text ?? '';
                    
                    // Set up a vscode.diagnostic object
                    const colEnd = mainLocDocument ? mainLocDocument.lineAt(line).text.length : col;
                    const diagnostic = setUpDiagnostic(line, col, line, colEnd, e.$.id, e.$.msg, severity);

                    diagnosticStore.track(diagnostic, { symbolName, mainLocLine });

                    // Parse Related Information
                    const relatedInfos: vscode.DiagnosticRelatedInformation[] = await extractRelatedInformation(locations);
                    if (relatedInfos.length > 0) {
                        diagnostic.relatedInformation = relatedInfos;
                    }
                    const diagnosticFile = mainLoc.file;
                    var diagnosticFileIsOpenDocument = diagnosticFile === document.fileName;
                    if (!diagnosticFile.includes('/')) {
                        // If we do not have file path but only name we asume diagnosed file is open document if they share name
                        if (document.fileName.endsWith(diagnosticFile)) {
                            diagnosticFileIsOpenDocument = true;
                        }
                    }
                    if (diagnosticFileIsOpenDocument) {
                        const uri = document.uri.toString();
                        if (diagnostics[uri] === null || diagnostics[uri] === undefined) {
                            diagnostics[uri] = [];
                        }
                        diagnostics[uri].push(diagnostic);
                    } else {
                        if (mainLocDocument) {
                            // Proceed if we have the document
                            const uri = mainLocDocument.uri.toString();
                            if (diagnostics[uri] === null || diagnostics[uri] === undefined) {
                                diagnostics[uri] = [];
                            }
                            diagnostics[uri].push(diagnostic);
                        }
                    }
                }
                // Map diagnostics to the uriDiagnosticsMap
                const sourceDocumentUri = document.uri.toString();
                diagnosticStore.add(diagnostics, sourceDocumentUri);

                resolve();
            });

            // If checks have run without error, save hashed document content to memory
            if (!code) {
                documentHashMemory.remember(document);
            }
        });
    });

    statusBar.setRunning(false);
}

async function runFullAnalysis(
    commandPath: string,
    processedArgs: string,
    threadsOption: string,
): Promise<void> {
    if (!processedArgs.includes("--project=")) {
        throw new Error("Full analysis called without specified project file!");
    }

    statusBar.setRunning(true);

    // Clear existing diagnostics for all files
    diagnosticStore.clearAll();

    // Clear file relation map when we run full analysis
    clearFileRelationMap();

    // We always call cppcheck with severity level info, and then filter warnings when displaying them
    const minSevNum = SeverityNumber.Info;

    // Resolve paths for arguments where applicable
    const argsParsed = splitArgsAndResolvePaths(processedArgs);

    const projectFileArgument = argsParsed.find((a) => a.includes('--project=')) ?? '';
    var projectFilePath = projectFileArgument.split('--project=')[1];
    projectFileStore.clear();
    projectFileStore.setUri(vscode.Uri.file(projectFilePath));

    const args = [
        '--enable=all',
        '--inline-suppr',
        '--xml',
        threadsOption,
        ...argsParsed,
    ].filter(Boolean);

    if (usesPremiumCppcheck) {
        args.push('--premium=safety-off');
    }

    let proc;
    const cwd = findWorkspaceRoot();
    proc = cp.spawn(commandPath, args, {
        cwd,
    });

    await new Promise<void>((resolve, reject) => {
        // if spawn fails (e.g. ENOENT or permission denied)
        proc.on("error", (err) => {
            console.error("Failed to start cppcheck:", err);
            vscode.window.showErrorMessage(`Cppcheck failed to start: ${err.message}`);
            reject(err);
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

                const errors = result?.results?.errors?.[0]?.error || [];
                const diagnostics: Record<string, vscode.Diagnostic[]> = {};
                for (const e of errors) {
                    const locations = e.location || [];
                    if (!locations.length) {
                        continue;
                    }

                    const mainLoc = locations[locations.length - 1].$;
                    let mainLocDocument : vscode.TextDocument | undefined;
                    try {
                        mainLocDocument = await vscode.workspace.openTextDocument(mainLoc.file);
                    } catch {
                        // If we can't open the file in the context of a full analysis we have no reference to where the error is occurring and are forced to skip it
                        vscode.window.showInformationMessage(`Unable to find location of error [${e.$.id}]: ${e.$.msg}`);
                        continue;
                    }

                    // Cppcheck line number is 1-indexed, while VS Code uses 0-indexing
                    let line = Number(mainLoc.line) - 1;
                    // Invalid line number usually means non-analysis output 
                    if (isNaN(line) || line < 0 || line >= mainLocDocument.lineCount) {
                        if (isCriticalWarning(e.$.id)) {
                            line = 0;
                        } else {
                            continue;
                        }
                    }

                    // Cppcheck col number is 1-indexed, while VS Code uses 0-indexing
                    let col = Number(mainLoc.column) - 1;
                    if (isNaN(col) || col < 0 || col > mainLocDocument.lineAt(line).text.length) {
                        col = 0;
                    }

                    const severity = parseSeverity(e.$.severity);
                    if (!isCriticalWarning(e.$.id) && severityToNumber(severity) < minSevNum) {
                        continue;
                    }

                    // If warning has a symbol we keep track of it
                    const symbolName = e.symbol?.[0] ?? '';
                    // Save line of code at main location
                    const mainLocLine = mainLocDocument.lineAt(line).text;

                    // Set up a vscode.diagnostic object
                    const colEnd = mainLocDocument ? mainLocDocument.lineAt(line).text.length : col;
                    const diagnostic = setUpDiagnostic(line, col, line, colEnd, e.$.id, e.$.msg, severity);
                    
                    diagnosticStore.track(diagnostic, { symbolName, mainLocLine });

                    // Parse Related Information
                    const relatedInfos: vscode.DiagnosticRelatedInformation[] = await extractRelatedInformation(locations);
                    
                    if (relatedInfos.length > 0) {
                        diagnostic.relatedInformation = relatedInfos;
                    }
                    
                    const uri = mainLocDocument.uri.toString();
                    if (diagnostics[uri] === null || diagnostics[uri] === undefined) {
                        diagnostics[uri] = [];
                    }
                    diagnostics[uri].push(diagnostic);
                }

                diagnosticStore.add(diagnostics);

                resolve();
            });
        });
    });

    statusBar.setRunning(false);
}

// This method is called when your extension is deactivated
export function deactivate() {}
