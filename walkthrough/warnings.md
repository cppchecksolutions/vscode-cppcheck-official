![Image showing how to suppress warnings](../images/suppression.png)

**Severity filter:** click **Cppcheck severity: …** in the status bar to choose which warnings are shown: **Info** shows everything, **Warning** shows warnings and errors, and **Error** shows only errors.

**Code actions:** put the cursor on a line with a cppcheck warning and click the lightbulb or press `Ctrl+.` (`Cmd+.` on macOS). You can:
- **Add a comment that suppresses the warning** (`// cppcheck-suppress <id>`). This is permanent.
- **Hide this warning** until the file is analysed again.
- **Hide all warnings of this type** until VS Code is restarted. Click **Hidden types: N** in the status bar to show them again.
- With a `.cppcheck` project file: **suppress the warning in the project file**, everywhere or only for a file or symbol.

See [Working with warnings](https://github.com/cppchecksolutions/vscode-cppcheck-official#working-with-warnings) in the README for details.

[Select severity](command:cppcheck-official.selectMinSeverity)