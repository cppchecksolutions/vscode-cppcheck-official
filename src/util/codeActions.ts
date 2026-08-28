import * as vscode from 'vscode';
import { DiagnosticMetadataStore, filterDiagnosticsDuplicatesForLine } from './diagnostics';
import { ProjectFileStore } from './files';
export class CodeActionProvider implements vscode.CodeActionProvider {
    constructor(
        private readonly metadataStore: DiagnosticMetadataStore,
        private readonly projectFileStore: ProjectFileStore
    ) {}
    provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range,
        context: vscode.CodeActionContext,
        token: vscode.CancellationToken
    ): vscode.CodeAction[] {

        const actions: vscode.CodeAction[] = [];

        // If same warning exists more than once on a given line we don't want duplicated code actions
        const diagnostics = filterDiagnosticsDuplicatesForLine(context.diagnostics);

        for (const diagnostic of diagnostics) {
            // Only provide these code actions for cppcheck errors
            if (diagnostic.source !== 'cppcheck') {
                continue;
            }

            const mainLocLineNumber = diagnostic.range.start.line;
            const lineText = document.lineAt(mainLocLineNumber).text;
            const expectedLineText = this.metadataStore.get(diagnostic)?.mainLocLine;

            // If document has been edited so that diagnostic no longer refers to the correct line we don't provide code actions
            if (lineText !== expectedLineText) {
                continue;
            }

            var diagnosticCode = diagnostic.code;
            if (typeof(diagnosticCode) === "object" && typeof(diagnosticCode) !== null) {
                diagnosticCode = diagnosticCode.value;
            }
            
            // Set up one action for suppressing the specific warning on the line targeted by the diagnostic
            const suppressAction = new vscode.CodeAction(
                `Add comment that suppresses this ${diagnosticCode} warning`,
                vscode.CodeActionKind.QuickFix
            );

            // Copy indentation from line affected by diagnostic
            const indent = lineText.match(/^\s*/)?.[0] ?? "";
            
            var affectedLine = diagnostic.range.start.line;
            var documentUri = document.uri;

            // Due to a quirk in cppcheck, even though last location for a multiple location warning is considered 'main location',
            // inline suppression should be added to the 1st location (reversed order in diagnostic relatedInformation)
            const multipleLocationWarning = (diagnostic.relatedInformation?.length ?? 0 ) > 0;
            if (multipleLocationWarning && diagnostic?.relatedInformation?.[0]) {
                const lastLocation = diagnostic?.relatedInformation?.[diagnostic?.relatedInformation?.length - 1].location;
                documentUri = lastLocation.uri;
                affectedLine = lastLocation.range.start.line;
            }

            // Insert suppression comment above affected line
            const suppressLineEdit = new vscode.WorkspaceEdit();
            suppressLineEdit.insert(
                documentUri,
                new vscode.Position(
                    affectedLine,
                    0,
                ),
                `${indent}// cppcheck-suppress ${diagnosticCode}\n`
            );
            suppressAction.edit = suppressLineEdit;

            // For inline suppression we also hide the warning so user does not have to rerun analysis for it to disappear
            suppressAction.command = {
                command: "cppcheck-official.hideWarning",
                title: "Hide warning",
                arguments: [document.uri, diagnosticCode, diagnostic.range]
            };
            suppressAction.diagnostics = [diagnostic];
            actions.push(suppressAction);

            // Set up an action for hiding a warning
            const hideAction = new vscode.CodeAction(
                `Hide this ${diagnosticCode} warning`,
                vscode.CodeActionKind.QuickFix
            );

            hideAction.command = {
                command: "cppcheck-official.hideWarning",
                title: "Hide warning",
                arguments: [document.uri, diagnosticCode, diagnostic.range]
            };

            hideAction.diagnostics = [diagnostic];
            actions.push(hideAction);

            // Set up an action for hiding all warnings of a given type
            const hideTypeAction = new vscode.CodeAction(
                `Hide all ${diagnosticCode} warnings`,
                vscode.CodeActionKind.QuickFix
            );

            hideTypeAction.command = {
                command: "cppcheck-official.hideWarningType",
                title: "Hide warning type",
                arguments: [diagnosticCode]
            };

            hideTypeAction.diagnostics = [diagnostic];
            actions.push(hideTypeAction);

            /* 
            * Actions only applicable if project file is used
            */
           if (this.projectFileStore.hasCppcheckProjectFile()) {
                // Set up an action for suppressing warning of a given type universally
                const suppressTypeAction = new vscode.CodeAction(
                    `Suppress warning type ${diagnosticCode} universally (in project file)`,
                    vscode.CodeActionKind.QuickFix
                );

                suppressTypeAction.command = {
                    command: "cppcheck-official.suppressWarningAll",
                    title: "Suppress warning universally",
                    arguments: [diagnosticCode]
                };

                suppressTypeAction.diagnostics = [diagnostic];
                actions.push(suppressTypeAction);

                // Set up an action for suppressing warning based on file or symbol name
                const symbol = this.metadataStore.get(diagnostic)?.symbolName;
                const suppressAdvancedAction = new vscode.CodeAction(
                    symbol
                    ? `Suppress warning ${diagnosticCode} based on file and / or symbol`
                    :`Suppress warning ${diagnosticCode} based on file`,
                    vscode.CodeActionKind.QuickFix
                );
                
                suppressAdvancedAction.command = {
                    command: "cppcheck-official.suppressWarningAdvanced",
                    title: "Suppress warning advanced",
                    arguments: [diagnosticCode, document, diagnostic]
                };

                suppressAdvancedAction.diagnostics = [diagnostic];
                actions.push(suppressAdvancedAction);
            }
        }

        return actions;
    }
}