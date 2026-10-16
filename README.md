# Cppcheck Official


**Cppcheck Official** is a Visual Studio Code extension that runs [cppcheck](https://cppcheck.sourceforge.io/) against C/C++ files when you open, save or switch to them, and reports any warnings or errors in the Problems panel.

![Image showing example of problem tab with warnings output from cppcheck](./images/check_result2.png)

## Features
- **Automatic analysis**: `cppcheck` runs automatically on a C/C++ file when you open it, save it or switch to its tab. See [When analysis runs](#when-analysis-runs).
- **Diagnostics for the analysed file and its headers**: Warnings for the analysed file are shown, together with warnings in the header files it includes (unless a project file is used, in which case only the analysed file's warnings are shown). Critical errors, such as `syntaxError`, are always shown.
- **Configurable severity threshold**: Filter out messages below a chosen severity level (`info`, `warning`, or `error`).
- **Diagnostic cleanup**: When you close a file, its diagnostics are automatically cleared. Warnings in a header file stay as long as another open file that includes it is still open.
- **Project file support**: You can feed your project file to cppcheck through the `--project` flag in the `cppcheck-official.arguments` field in the extension settings. (See image below)

![Image showing where to set up project file](./images/project_file.png)
- **Warning notes**: Display notes for warnings when those are available
- **Dynamic config**: The extension supports running a script to generate arguments to pass to cppcheck. This can be done by including the command in the argument field wrapped with \@(), e.g. `--suppress=memleak:src/file1.cpp @(bash path/to/script.sh)`. The script is expected to output the argument(s) wrapped with \@(). If the script e.g. creates a project file it should print out as `@(--project=path/to/projectfile.json)`. This output will be spliced into the argument string as such: `--suppress=memleak:src/file1.cpp --project=path/to/projectfile.json`.

- **Warning suppression**: Warnings of a specific type can be suppressed with the `--suppress` flag in the argument field in the extension settings. The extension also supports inline suppression for specific lines of code, simply write `// cppcheck-suppress <warning id>` (see image below). Suppressions can also be added through code actions, either as automatically generated inline suppressions or, if you are using a `.cppcheck` project file, as universal suppressions specified in your project file. Adding suppressions to the project file is not supported for `compile_commands.json` or other project types.
![Image showing how to suppress warnings](./images/suppression.png)

## When analysis runs

The extension analyses one C/C++ file at a time. Analysis runs when:
- You save a C or C++ file.
- You open a C or C++ file.
- You switch to a file's tab.
- You open a file in a preview tab (for example with a single click in the Explorer). Analysis starts after a short delay if you stay on the file. The file's warnings are cleared when you switch to another editor.
- VS Code starts or a workspace folder is added. All open C/C++ files are then analysed.

Analysis is skipped when:
- The file isn't a C or C++ file. The extension uses VS Code's language mode for this, so the file must be shown as `C` or `C++` in the status bar.
- The file isn't visible in any editor.
- The file content hasn't changed since the last successful analysis. The extension forgets the content when the file is closed, so reopening a file analyses it again.
- `cppcheck-official.enable` is `false`. The file's warnings are cleared instead.

Cppcheck analyses the file as it is saved on disk, not the unsaved content in the editor. Warnings for unsaved changes appear after you save the file.

While an analysis runs, the status bar shows **Cppcheck Running**.

## Requirements

 **Cppcheck** must be installed on your system.
  - By default, this extension looks for `cppcheck` on the system PATH.
  - Alternatively, specify a custom executable path using the `cppcheck-official.path` setting.

![Image showing location of path setting](./images/cppcheck_path.png)

Examples of installing Cppcheck:
  - On Linux (Debian/Ubuntu), install via `sudo apt-get install cppcheck`.
  - On macOS with Homebrew: `brew install cppcheck`.
  - On Windows, install from [cppcheck's website](https://cppcheck.sourceforge.io/).

## Extension Settings

This extension contributes the following settings under `cppcheck-official.*`:

- **`cppcheck-official.enable`**: (boolean) Enable or disable the extension.  
- **`cppcheck-official.minSeverity`**: (string) Minimum severity to report (`info`, `warning`, or `error`).  `info` shows style, performance, portability and information messages.
- **`cppcheck-official.arguments`**: (string) Additional command line arguments to pass to `cppcheck`. See the Cppcheck manual ([open source](https://cppcheck.sourceforge.io/manual.pdf#page=4) / [Premium](https://files.cppchecksolutions.com/manual.pdf#page=4)).  
- **`cppcheck-official.path`**: (string) Path to the `cppcheck` executable (e.g. `/path/to/cppcheck.exe`). If left empty, `cppcheck` from the system PATH is used. Supports paths relative to workspace folder on the formats `./RELATIVE_PATH`, `../RELATIVE_PATH` or `${workspaceFolder}/RELATIVE_PATH`.

## Shared Settings File

To give all developers in a project the same setup, create a `cppcheck.json` file in the root of the workspace folder and commit it to version control:

```json
{
  "arguments": "--project=build/compile_commands.json --enable=style --suppress=missingInclude"
}
```

`arguments` can be either a string or an array of strings. If the file specifies `arguments`, it takes precedence over the `cppcheck-official.arguments` setting. Relative paths are resolved relative to the workspace folder. All other settings are still read from the VS Code settings, so each developer can adjust them individually.

## Reporting Issues
Please submit any issues or feature requests via the [GitHub Issues page](https://github.com/cppchecksolutions/vscode-cppcheck-official/issues).

## Acknowledgements
This plugin is forked from the plugin cppcheck-lite by Justus Rijke (https://github.com/JustusRijke/Cppcheck-Lite).