import { exec } from "child_process";
import { resolvePath } from './path';
import util from 'util';

const execAsync = util.promisify(exec);

async function runCommand(command : string) {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: resolvePath('${workspaceFolder}'),
    });

    if (stderr) {
      throw new Error(stderr);
    }
    return stdout;
  } catch (error) {
    throw error;
  }
}

export { runScript, runCommand };