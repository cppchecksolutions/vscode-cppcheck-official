import * as vscode from 'vscode';

export async function writeSuppressionToProjectFile(projectFileUri : vscode.Uri, warningType : String) {
    const fileType = projectFileUri.toString().split('.')[1];
    if (fileType !== 'cppcheck') {
        throw new Error(`Function writeSuppressionToProjectFile only supports writing to .cppcheck project files! Recieved file is of type .${fileType}`);
    }

    // Open project file with vscode workspace API
    const document = await vscode.workspace.openTextDocument(projectFileUri);
    const text = document.getText();
    const edit = new vscode.WorkspaceEdit();
    var textToInsert = '';
    var positionToInsertAt = 0;

    // Search for suppressions section
    const match = /<suppressions\b[^>]*>([\s\S]*?)<\/suppressions>/m.exec(text);
    if (match !== null) {
        // match !== null -> Suppressions section exists
        const closeIndex = text.indexOf("</suppressions>");
        
        // Determine indentation and construct the new suppression line
        const line = document.lineAt(document.positionAt(closeIndex).line - 1);
        const indentation = line.text.match(/^\s*/)?.[0] ?? "    ";
        const newSuppressionLine = `\n${indentation}<suppression id="${warningType}"/>\n`;

        // We splice in the new line just before the end of the suppressions block
        textToInsert = newSuppressionLine;
        positionToInsertAt = closeIndex;
    } else {
        // match === null -> Suppressions section does not exist
        const closeIndex = text.indexOf("</project>");

        // Determine indentation and construct the new suppressions block
        const line = document.lineAt(document.positionAt(closeIndex).line - 1);
        const indentation = line.text.match(/^\s*/)?.[0] ?? "    ";
        const suppressionsBlock =
            `\n${indentation}<suppressions>
            ${indentation}    <suppression id="${warningType}"/>
            ${indentation}</suppressions>\n`;

        // Splice in the new suppressions block just before the end of the project-file
        textToInsert = suppressionsBlock;
        positionToInsertAt = closeIndex;
    }

    // Write file
    edit.insert(
        document.uri,
        document.positionAt(positionToInsertAt),
        textToInsert
    );

    await vscode.workspace.applyEdit(edit);
}