import { execFile } from "child_process";
import { resolvePath } from './path';

function runScript(scriptCommand: string): Promise<string> {
  const scriptParts : string[] = scriptCommand.split(" ");
  // ASSUMPTION: script path will be the last part of the command
  const scriptPath = scriptParts[scriptParts.length -1];
  const absoluteScriptPath = resolvePath(scriptPath);
  const joinedCommand = scriptParts.slice(0, scriptParts.length -1).join(" ") + " " + absoluteScriptPath;
  return new Promise((resolve, reject) => {
    execFile(joinedCommand, [], { cwd: resolvePath('${workspaceFolder}') }, (error, stdout, stderr) => {
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