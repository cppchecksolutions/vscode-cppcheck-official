import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { findWorkspaceRoot } from './path';

// Shared settings file that can be committed to the repository so that all developers get the same settings.
// Settings in this file take precedence over the VS Code settings.
export const settingsFileName = 'cppcheck.json';

interface SettingsFile {
    arguments?: string;
}

// Remember the last reported error so that the user is not spammed with the same message on every analysis
let lastReportedError = '';

export function getSettingsFilePath(): string {
    return path.join(findWorkspaceRoot(), settingsFileName);
}

function readSettingsFile(): SettingsFile | undefined {
    const filePath = getSettingsFilePath();
    if (!fs.existsSync(filePath)) {
        lastReportedError = '';
        return undefined;
    }

    try {
        const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (typeof content !== 'object' || content === null || Array.isArray(content)) {
            throw new Error('expected a JSON object');
        }

        const settings: SettingsFile = {};
        if (content.arguments !== undefined) {
            // Arguments may be given either as a string or as an array of strings
            if (typeof content.arguments === 'string') {
                settings.arguments = content.arguments;
            } else if (Array.isArray(content.arguments) && content.arguments.every((a: unknown) => typeof a === 'string')) {
                settings.arguments = content.arguments.join(' ');
            } else {
                throw new Error('"arguments" must be a string or an array of strings');
            }
        }
        lastReportedError = '';
        return settings;
    } catch (error) {
        const message = `Cppcheck: Failed to read ${filePath}: ${error instanceof Error ? error.message : error}`;
        if (message !== lastReportedError) {
            lastReportedError = message;
            vscode.window.showErrorMessage(message);
        }
        return undefined;
    }
}

// Get cppcheck arguments, from the settings file if it specifies them, otherwise from the VS Code settings
export function getArguments(config: vscode.WorkspaceConfiguration): string {
    const settings = readSettingsFile();
    if (settings?.arguments !== undefined) {
        return settings.arguments;
    }
    return config.get<string>("cppcheck-official.arguments", "");
}
