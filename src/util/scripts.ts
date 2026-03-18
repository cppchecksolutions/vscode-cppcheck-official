import { execFile } from "child_process";

function runScript(scriptCommand: string): Promise<string> {
  const commandSplit = scriptCommand.split("  ");
  const scriptLang = commandSplit[0];
  const scriptPath = commandSplit[1];
  // Additional args could be added here, i.e. name of output file if applicable
  return new Promise((resolve, reject) => {
    execFile(scriptLang, [scriptPath], (error, stdout, stderr) => {
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