import * as crypto from 'crypto';
import * as vscode from 'vscode';

export function getDocumentSha1(document: Pick<vscode.TextDocument, 'getText'>): string {
    return crypto.createHash('sha1').update(document.getText(), 'utf8').digest('hex');
}

// Remembers the content of documents that were analyzed successfully
export class DocumentHashMemory {
    private readonly hashes = new Map<string, string>();

    isUnchanged(document: vscode.TextDocument): boolean {
        const old = this.hashes.get(document.fileName);
        return old !== undefined && old === getDocumentSha1(document);
    }
    remember(document: vscode.TextDocument) {
        this.hashes.set(document.fileName, getDocumentSha1(document));
    }
    forget(document: vscode.TextDocument) {
        this.hashes.delete(document.fileName);
    }
}