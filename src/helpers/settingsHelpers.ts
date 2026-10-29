import { runCommand } from "../util/scripts";
import * as vscode from 'vscode';

export enum SeverityNumber {
    Info = 0,
    Warning = 1,
    Error = 2
}

export async function processArguments(args : string) {
    // If user enter arguments as array we parse them into space separated string format
    if (args.startsWith("[") && args.endsWith("]")) {
        args = args.replaceAll("[", "").replaceAll("]", "").replaceAll(",", " ");
    }
    
    var processedArgs = '';
    // If argument field contains command to run script we do so here
    if (args.includes('@(')) {
        const scriptCommand = args.split("@(")[1].split(")")[0];
        const scriptOutput = await runCommand(scriptCommand);
        // We expect that the script output that is to be used as arguments will be wrapped with ${}
        const scriptOutputTrimmed = scriptOutput.split("@(")[1].split(")")[0];
        processedArgs = args.split("@(")[0] + scriptOutputTrimmed + args.split(")")?.[1];
    } else {
        processedArgs = args;
    }
    return processedArgs;
}


export function parseSeverity(str: string): vscode.DiagnosticSeverity {
    const lower = str.toLowerCase();
    if (lower.includes("error")) {
        return vscode.DiagnosticSeverity.Error;
    } else if (lower.includes("warning")) {
        return vscode.DiagnosticSeverity.Warning;
    } else {
        return vscode.DiagnosticSeverity.Information;
    }
}

export function severityToNumber(sev: vscode.DiagnosticSeverity): SeverityNumber {
    switch (sev) {
        case vscode.DiagnosticSeverity.Error: return SeverityNumber.Error;
        case vscode.DiagnosticSeverity.Warning: return SeverityNumber.Warning;
        default: return SeverityNumber.Info;
    }
}