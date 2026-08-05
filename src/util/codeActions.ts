import * as vscode from 'vscode';
import { DiagnosticMetadataStore } from './diagnostics';
export class CodeActionProvider implements vscode.CodeActionProvider {
    constructor(
        private readonly metadataStore: DiagnosticMetadataStore
    ) {}
    provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range,
        context: vscode.CodeActionContext,
        token: vscode.CancellationToken
    ): vscode.CodeAction[] {

        const actions: vscode.CodeAction[] = [];

        for (const diagnostic of context.diagnostics) {
            // Only provide these code actions for cppcheck errors
            if (diagnostic.source !== 'cppcheck') {
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
            const lineText = document.lineAt(diagnostic.range.start.line).text;
            const indent = lineText.match(/^\s*/)?.[0] ?? "";
            
            // Insert suppression comment above affected line
            const suppressLineEdit = new vscode.WorkspaceEdit();
            suppressLineEdit.insert(
                document.uri,
                new vscode.Position(
                    diagnostic.range.start.line,
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
        }

        return actions;
    }
}