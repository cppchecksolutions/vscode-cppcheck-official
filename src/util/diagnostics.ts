import * as vscode from 'vscode';

export class CodeActionProvider implements vscode.CodeActionProvider {
    provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range,
        context: vscode.CodeActionContext,
        token: vscode.CancellationToken
    ): vscode.CodeAction[] {

        const actions: vscode.CodeAction[] = [];

        for (const diagnostic of context.diagnostics) {
            var diagnosticCode = diagnostic.code;
            if (typeof(diagnosticCode) === "object" && typeof(diagnosticCode) !== null) {
                diagnosticCode = diagnosticCode.value;
            }
            
            // Set up one action for suppressing the specific warning on the line targeted by the diagnostic
            const suppressAction = new vscode.CodeAction(
                `Suppress warning for ${diagnosticCode} here`,
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
            suppressAction.diagnostics = [diagnostic];
            actions.push(suppressAction);

            // Set up one action for suppressing warning of a given type universally
            const suppressTypeAction = new vscode.CodeAction(
                `Suppress warning type ${diagnosticCode} universally`,
                vscode.CodeActionKind.QuickFix
            );

            suppressTypeAction.command = {
                command: "cppcheck-official.suppressWarningAll",
                title: "Suppress warning here",
                arguments: [diagnostic]
            };

            suppressTypeAction.diagnostics = [diagnostic];
            actions.push(suppressTypeAction);
        }

        return actions;
    }
}

export function diagnosticsUnion(diagnosticsA : vscode.Diagnostic[], diagnosticB : vscode.Diagnostic[]) : vscode.Diagnostic[] {
    const diagnosticsUnion = new Array<vscode.Diagnostic>;
    // Add all elements from diagnosticsA to result array
    diagnosticsUnion.push(...diagnosticsA);

    // Add all elements present in diagnosticsB but not in diagnosticsA to result array 
    for (const diagnostic of diagnosticB) {
        if (!diagnosticsA.some((d) => {
            if (typeof(diagnostic?.code) === "object" && typeof(diagnostic?.code) !== null && typeof(d?.code) === "object" && typeof(d?.code) !== null) {
                return diagnostic.code.value === d.code.value && diagnostic.range.isEqual(d.range);
            } else {
                return diagnostic.code === d.code && diagnostic.range.isEqual(d.range);
            }
        })) {
            diagnosticsUnion.push(diagnostic);
        }
    }
    
    // Return result
    return diagnosticsUnion;
}