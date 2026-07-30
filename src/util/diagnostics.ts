import * as vscode from 'vscode';

export async function guessSymbolName(doc : vscode.TextDocument, diagnostic : vscode.Diagnostic) : Promise<string> {
    const lineNumber = diagnostic.range.start.line;
    const line = doc.lineAt(lineNumber);
    const functionRegex = /^\s*(?:[\w:<>,~*&]+\s+)+([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s*\(/;
    const variableRegex = /^\s*(?:[\w:<>,~*&]+\s+)+([A-Za-z_]\w*)\s*(?:=|;|\[)/;
    const potentialFunctionName = functionRegex.exec(line.text);
    const potentialVariableName = variableRegex.exec(line.text);
    if (potentialFunctionName?.[1]) {
        return potentialFunctionName[1];
    }
    if (potentialVariableName?.[1]) {
        return potentialVariableName[1];
    }
    return '';
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