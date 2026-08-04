import * as vscode from 'vscode';

interface DiagnosticMetadata {
    symbolName?: string;
}

export class DiagnosticMetadataStore {
    private readonly map = new WeakMap<vscode.Diagnostic, DiagnosticMetadata>();

    set(diagnostic: vscode.Diagnostic, metadata: DiagnosticMetadata) {
        this.map.set(diagnostic, metadata);
    }

    get(diagnostic: vscode.Diagnostic) {
        return this.map.get(diagnostic);
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