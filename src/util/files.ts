import * as vscode from 'vscode';
import * as path from "path";
import * as fs from 'fs';
import * as xml2js from 'xml2js';

export class ProjectFileStore {
    private projectFileUri : vscode.Uri | undefined;

    setUri(newProjectFileUri: vscode.Uri) {
        this.projectFileUri = newProjectFileUri;
    }

    getUri() {
        return this.projectFileUri;
    }

    hasCppcheckProjectFile() {
        const uri = this.getUri();
        if (!uri) {
            return false;
        }
        var projectFileType = getFileType(uri.path);
        return projectFileType.toLowerCase() === 'cppcheck'; 
    }

    clear() {
        this.projectFileUri = undefined;
    }
}

export function getFileType(path : string) {
    const splitFilePath = path.split('.');
    return splitFilePath[splitFilePath.length - 1]; 
}

function escapeXml(value: string): string {
    return value.replace(/[<>&"']/g, (char) => {
        switch (char) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '"': return '&quot;';
            case "'": return '&apos;';
            default: return char;
        }
    });
}

export async function writeSuppressionToProjectFile(projectFileUri : vscode.Uri, warningType : string, file? : string, symbolName? : string) : Promise<boolean> {
    const fileType = getFileType(projectFileUri.toString());
    if (fileType !== 'cppcheck') {
        throw new Error(`Function writeSuppressionToProjectFile only supports writing to .cppcheck project files! Recieved file is of type .${fileType}`);
    }
    // Open project file with vscode workspace API
    const document = await vscode.workspace.openTextDocument(projectFileUri);
    const text = document.getText();
    const edit = new vscode.WorkspaceEdit();
    var textToInsert = '';
    var positionToInsertAt = 0;

    // If file or symbolName is specified we set up that part of the suppression block
    let options = '';
    if (file) {
        options = ` file="${escapeXml(file)}"`;
    }
    if (symbolName) {
        options += ` symbolName="${escapeXml(symbolName)}"`;
    }

    // Search for suppressions section
    const match = /<suppressions\b[^>]*>([\s\S]*?)<\/suppressions>/m.exec(text);
    // TODO: Currently, if project file has specified self-closing <suppressions/> block the extension will add an additional suppressions-block
    if (match !== null) {
        // match !== null -> Suppressions section exists
        let closeIndex = text.indexOf("</suppressions>");
        
        if (closeIndex < 0) {
            return false; 
        }
        // Determine indentation and construct the new suppression line
        const endOfSuppressionsBlockLine = document.lineAt(document.positionAt(closeIndex).line);
        const indentation = endOfSuppressionsBlockLine.text.match(/^\s*/)?.[0] ?? "    ";
        const newSuppressionLine = `${indentation}<suppression${options}>${warningType}</suppression>\n${indentation}`;

        // We splice in the new line just before the end of the suppressions block
        textToInsert = newSuppressionLine;
        positionToInsertAt = closeIndex;
    } else {
        // match === null -> Suppressions section does not exist
        const closeIndex = text.indexOf("</project>");
        if (closeIndex < 0) {
            return false;
        }
        // Determine indentation and construct the new suppressions block
        const line = document.lineAt(document.positionAt(closeIndex).line - 1);
        const indentation = line.text.match(/^\s*/)?.[0] ?? "    ";
        const suppressionsBlock = `${indentation}<suppressions>\n${indentation}    <suppression${options}>${warningType}</suppression>\n${indentation}</suppressions>\n`;

        // Splice in the new suppressions block just before the end of the project-file
        textToInsert = suppressionsBlock;
        positionToInsertAt = closeIndex;
    }

    // Apply edit to document
    edit.insert(
        document.uri,
        document.positionAt(positionToInsertAt),
        textToInsert
    );
    const success = await vscode.workspace.applyEdit(edit);
    
    // Write file
    await document.save();
    return success;
}

export async function isFileInCompilationDatabase(dbPath: string, filePath: string): Promise<boolean> {
    try {
        const entries = JSON.parse(await fs.promises.readFile(dbPath, 'utf8'));
        const normalize = (p: string) => {
            const n = path.normalize(p);
            return process.platform === 'win32' ? n.toLowerCase() : n;
        };
        const target = normalize(filePath);
        return entries.some((e: { file: string; directory?: string }) =>
            normalize(path.resolve(e.directory ?? '', e.file)) === target);
    } catch {
        // If we cannot read or parse the database, let cppcheck decide
        return true;
    }
}

async function getImportedProjectPath(cppcheckProjectFile: string): Promise<string | undefined> {
    try {
        const content = await fs.promises.readFile(cppcheckProjectFile, 'utf8');
        const parsed = await new xml2js.Parser({ explicitArray: true }).parseStringPromise(content);
        const imported: unknown = parsed?.project?.importproject?.[0];
        if (typeof imported !== 'string' || imported.trim() === '') {
            return undefined;
        }
        const normalized = imported.trim().replaceAll('\\', '/');
        return path.isAbsolute(normalized)
            ? path.normalize(normalized)
            : path.resolve(path.dirname(cppcheckProjectFile), normalized);
    } catch {
        // Unreadable or invalid XML: let cppcheck report the problem itself
        return undefined;
    }
}

export async function getCompilationDatabasePath(absoluteProjectFilePath: string): Promise<string | undefined> {
    if (absoluteProjectFilePath.endsWith('.json')) {
        return absoluteProjectFilePath;
    }
    if (absoluteProjectFilePath.endsWith('.cppcheck')) {
        const imported = await getImportedProjectPath(absoluteProjectFilePath);
        // <importproject> can also point to .sln / .vcxproj files, which this check does not handle
        return imported?.endsWith('.json') ? imported : undefined;
    }
    return undefined;
}