import { execFile } from "child_process";
import { resolvePath } from './path';

function runScript(scriptPath: string): Promise<string> {
  const absoluteScriptPath = resolvePath(scriptPath);
  const workspaceFolder = resolvePath('${workspaceFolder}');
  return new Promise((resolve, reject) => {
    execFile(absoluteScriptPath, [], { cwd: workspaceFolder }, (error, stdout, stderr) => {
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