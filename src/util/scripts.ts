import { execFile } from "child_process";
import { resolvePath } from './path';

function runScript(scriptCommand: string): Promise<string> {
  const commandSplit = scriptCommand.split(" ");
  const scriptLang = commandSplit[0];
  const scriptPath = resolvePath(commandSplit[1]);
  const workspaceFolder = resolvePath('${workspaceFolder}');
  // Additional args could be added here, i.e. name of output file if applicable
  return new Promise((resolve, reject) => {
    execFile(scriptLang, [scriptPath], { cwd: workspaceFolder }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      if (stderr) {
        console.warn("Script stderr:", stderr);
      }
      const result = stdout.trim();
      resolve(result);
    });
  });
}


export { runScript };