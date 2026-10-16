import { exec } from "child_process";
import { resolvePath } from './path';
import * as vscode from 'vscode';
import util from 'util';

const execAsync = util.promisify(exec);

async function runCommand(command : string) {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: resolvePath('${workspaceFolder}'),
    });

    if (stderr) {
      vscode.window.showErrorMessage(`Command produced stderr: ${stderr}`);
    }
    return stdout;
  } catch (error) {
    throw error;
  }
}

export { runCommand };