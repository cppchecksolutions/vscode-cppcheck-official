// util/diagnosticStore.ts
import * as vscode from 'vscode';
import { diagnosticsUnion, getDiagnosticCode } from './diagnostics';
import { severityToNumber } from '../helpers/settingsHelpers';

export interface DiagnosticMetadata {
    symbolName?: string;
    mainLocLine?: string;
    hidden: boolean;
}

// What the code action provider needs, and nothing more
export interface DiagnosticMetadataReader {
    get(diagnostic: vscode.Diagnostic): DiagnosticMetadata | undefined;
}

export class DiagnosticStore implements DiagnosticMetadataReader {
    // Keyed on the diagnostic object, so entries disappear together with the diagnostics
    private readonly metadata = new WeakMap<vscode.Diagnostic, DiagnosticMetadata>();
    private readonly diagnosticsByUri = new Map<string, vscode.Diagnostic[]>();
    private readonly sourcesByUri = new Map<string, Set<string>>();
    private readonly hiddenTypes = new Set<string>();

    constructor(private readonly collection: vscode.DiagnosticCollection) {}

    add(diagnostics: Record<string, vscode.Diagnostic[]>, sourceDocumentUri?: string) {
        for (const [uri, incoming] of Object.entries(diagnostics)) {
            // If file has existing diagnostics from analyzing other files we do not want to overwrite those
            const existing = this.diagnosticsByUri.get(uri);
            this.diagnosticsByUri.set(uri, existing ? diagnosticsUnion(incoming, existing.flat()) : incoming);

            if (sourceDocumentUri) {
                let sources = this.sourcesByUri.get(uri);
                if (!sources) {
                    sources = new Set();
                    this.sourcesByUri.set(uri, sources);
                }
                // NOTE: uri can be the same as sourceDocumentUri
                sources.add(sourceDocumentUri);
            }
        }
    }

    get(diagnostic: vscode.Diagnostic): DiagnosticMetadata | undefined {
        return this.metadata.get(diagnostic);
    }

    getByUri(uri: vscode.Uri): vscode.Diagnostic[] | undefined {
        return this.diagnosticsByUri.get(uri.toString());
    }

    // Call once for every diagnostic created from cppcheck output (was metadataStore.set with hidden: false)
    track(diagnostic: vscode.Diagnostic, info: { symbolName?: string; mainLocLine?: string }) {
        this.metadata.set(diagnostic, { ...info, hidden: false });
    }

    get hiddenTypeCount() { return this.hiddenTypes.size; }
    getHiddenTypes(): string[] { return Array.from(this.hiddenTypes); }

    // Start of a full analysis
    clearAll() {
        this.diagnosticsByUri.clear();
        this.sourcesByUri.clear();
    }

    // Start of a single file analysis
    resetFile(uri: string) {
        this.diagnosticsByUri.set(uri, []);
    }

    hideWarning(uri: string, code: string, range: vscode.Range) {
        this.diagnosticsByUri.get(uri)?.forEach(d => {
            if (getDiagnosticCode(d) === code && d.range.isEqual(range)) {
                this.setHidden(d, true);
            }
        });
        this.refresh();
    }

    hideType(code: string) {
        this.setHiddenByType(code, true);
        this.hiddenTypes.add(code);
        this.refresh();
    }

    revealType(code: string) {
        this.hiddenTypes.delete(code);
        this.setHiddenByType(code, false);
        this.refresh();
    }

    applyMinSeverity(minSeverity: vscode.DiagnosticSeverity) {
        for (const diagnostics of this.diagnosticsByUri.values()) {
            for (const d of diagnostics) {
                this.setHidden(d, severityToNumber(d.severity) < severityToNumber(minSeverity));
            }
        }
        this.refresh();
    }

    clearForDocument(documentUri: string) {
        // Files whose warnings come (only) from the closed document have their diagnostics cleared
        for (const [fileUri, sources] of this.sourcesByUri) {
            if (!sources.has(documentUri)) {
                continue;
            }
            if (sources.size <= 1) {
                this.diagnosticsByUri.delete(fileUri);
                this.collection.delete(vscode.Uri.parse(fileUri));
                sources.clear();
                this.refresh();
            } else {
                sources.delete(documentUri);
            }
        }
    }

    refresh() {
        for (const type of this.hiddenTypes) {
            this.setHiddenByType(type, true);
        }
        this.collection.clear();
        this.diagnosticsByUri.forEach((diagnostics, uri) => {
            this.collection.set(
                vscode.Uri.parse(uri),
                diagnostics.filter(d => !this.get(d)?.hidden)
            );
        });
    }

    private setHidden(diagnostic: vscode.Diagnostic, hidden: boolean) {
        this.metadata.set(diagnostic, { ...this.metadata.get(diagnostic), hidden });
    }

    private setHiddenByType(code: string, hidden: boolean) {
        for (const diagnostics of this.diagnosticsByUri.values()) {
            for (const d of diagnostics) {
                if (getDiagnosticCode(d) === code) {
                    this.setHidden(d, hidden);
                }
            }
        }
    }
}