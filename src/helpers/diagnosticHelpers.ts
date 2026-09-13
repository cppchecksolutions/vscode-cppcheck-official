import * as vscode from 'vscode';
import { documentationLinkMap, getPremiumCertLink } from '../util/documentation';
interface locationObject {
    info: string,
    line: string,
    col: string,
    file: string,
}

interface XmlAnalysisOutput {
    $: locationObject;
}

export function setUpDiagnostic(lineStart : number, colStart : number, lineEnd : number, colEnd : number, warningId : string, warningMessage : string, severity : vscode.DiagnosticSeverity) {
    const range = new vscode.Range(lineStart, colStart, lineEnd, colEnd);
    const diagnostic = new vscode.Diagnostic(range, warningMessage, severity);
    diagnostic.source = "cppcheck";
    // If we have a link to documentation, include it
    diagnostic.code = documentationLinkMap[warningId] ? {
        value: warningId,
        target: vscode.Uri.parse(documentationLinkMap[warningId])
    } : getPremiumCertLink(warningId) ? {
        value: warningId,
        target: vscode.Uri.parse(getPremiumCertLink(warningId))
    } : warningId;
    return diagnostic;
}

export async function extractRelatedInformation(locations : Array<XmlAnalysisOutput>) {
    const relatedInfos: vscode.DiagnosticRelatedInformation[] = [];
    for (let i = 1; i <= locations.length; i++) {
        // Related information is ordered in reverse in XML object
        const loc = locations[locations.length - i].$;
        const msg = loc.info;
        const lLine = Number(loc.line) - 1;
        const lCol = Number(loc.col) - 1;

        if (msg === null || msg === undefined || isNaN(lLine) || lLine < 0) {
            continue;
        }
        
        var relatedDocument : vscode.TextDocument | undefined;
        try {
            relatedDocument = await vscode.workspace.openTextDocument(loc.file);
        } catch {
            // Do nothing
        }

        if (relatedDocument && lLine > relatedDocument.lineAt(lLine).text.length) {
            continue;
        }

        const relatedRange = new vscode.Range(
            lLine, lCol,
            lLine, relatedDocument ? relatedDocument.lineAt(lLine).text.length : lCol
        );
        relatedInfos.push(
            new vscode.DiagnosticRelatedInformation(
                new vscode.Location(relatedDocument ? relatedDocument.uri : vscode.Uri.file(''), relatedRange),
                msg
            )
        );
    }
    return relatedInfos;
}