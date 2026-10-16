Normally the extension analyses only the files you open. A full analysis runs cppcheck on every file in your project file and shows the warnings for all of them in the Problems panel, including files you haven't opened.

Full analysis needs a project file (`--project=…` in the arguments or in `cppcheck.json`). The **Full Analysis** button appears in the status bar after a file has been analysed with a project file. Click it and choose how many threads cppcheck should use.

The warnings stay in the Problems panel until the next full analysis. A full analysis can take a long time on a large project.

See [Full analysis](https://github.com/cppchecksolutions/vscode-cppcheck-official#full-analysis) in the README for details.

[Read about full analysis](https://github.com/cppchecksolutions/vscode-cppcheck-official#full-analysis)