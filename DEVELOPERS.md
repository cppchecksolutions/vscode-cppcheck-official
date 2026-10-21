# Developer Notes

This guide describes how to build, debug, test and release the Cppcheck Official extension. For how the extension behaves, see [README.md](README.md).

## Prerequisites

- [Node.js](https://nodejs.org/) and npm. CI tests with Node.js 22.x and 24.x.
- [VS Code](https://code.visualstudio.com/) 1.96 or later.
- [cppcheck](https://cppcheck.sourceforge.io/) on the PATH, for trying out the extension manually.

## Build

```bash
npm ci              # install dependencies from package-lock.json
npm run compile     # compile TypeScript from src/ to out/
npm run watch       # compile and recompile on every change
npm run lint        # run ESLint on src/
```

## Debug

Open the repository in VS Code and press `F5`. This runs the **Run Extension** launch configuration (`.vscode/launch.json`). It starts the `watch` build task and opens an Extension Development Host window with the extension loaded. Open a folder with C/C++ files in that window to try it out.

- Breakpoints in `src/*.ts` work, because source maps are generated.
- Output from `console.log` and `console.error` in the extension appears in the **Debug Console** of the window you pressed `F5` in.
- When the extension is installed normally, that output and unhandled errors appear in the **Extension Host** log (**Output** panel, or **Developer: Show Logs…**).
- Error notifications from cppcheck include the full command line, which you can run in a terminal from the workspace folder.

## Tests

```bash
npm test
```

`npm test` first runs the `pretest` script (`compile` and `lint`), then runs `vscode-test`. [`@vscode/test-cli`](https://github.com/microsoft/vscode-test-cli) downloads VS Code and runs the Mocha tests in `out/test/**/*.test.js` (compiled from `src/test/*.test.ts`) inside it. The configuration is in `.vscode-test.mjs`.

To run a single test file, compile first and pass the compiled file to `--run`:

```bash
npm run compile
npx vscode-test --run out/test/settingsFile.test.js
```

Use `--grep <pattern>` to run only the tests whose names match a pattern.

On Linux without a display, the tests need a virtual X server, for example:

```bash
xvfb-run -a npm test
```

CI uses [`coactions/setup-xvfb`](https://github.com/coactions/setup-xvfb) for this.

## CI

`.github/workflows/ci.yml` runs on every push:

1. **test**: on Ubuntu, Windows and macOS with Node.js 22.x and 24.x, runs `npm ci`, `npm run lint`, `npm run compile` and `npm test`.
2. **package**: after all test jobs pass, runs `vsce package` and uploads the `.vsix` as the `vscode-extension` artifact. You can download it from the workflow run to test a build without packaging it yourself.

## Project structure

| Path | Contents |
| --- | --- |
| `src/extension.ts` | Activation, commands, status bar items, event listeners, running cppcheck and turning its XML output into diagnostics. |
| `src/util/` | Code actions (`codeActions.ts`), diagnostic metadata (`diagnostics.ts`), links to checker documentation (`documentation.ts`), project file handling and suppressions (`files.ts`), path resolution (`path.ts`), `@(…)` scripts (`scripts.ts`) and `cppcheck.json` (`settingsFile.ts`). |
| `src/helpers/` | Helpers for creating diagnostics and related information (`diagnosticHelpers.ts`). |
| `src/test/` | Tests, run with `npm test`. |
| `walkthrough/` | Markdown pages for the Getting Started walkthrough. The steps are defined in `package.json` under `contributes.walkthroughs`. |
| `schemas/` | JSON schema for `cppcheck.json`, registered in `package.json` under `contributes.jsonValidation`. |
| `images/` | Images used in the README and the walkthrough. |

Settings are defined in `package.json` under `contributes.configuration`. When you change a setting or add a feature, also update `README.md`, and the walkthrough if it is affected.

## Release

1. Update the version in `package.json` and `package-lock.json`, e.g. with `npm version patch --no-git-tag-version`. Merge this as a PR (e.g. "maintenance / update version to 1.0.17").
2. Package the extension and test the `.vsix`:

   ```bash
   npm install -g @vscode/vsce
   vsce package
   code --install-extension cppcheck-official-<version>.vsix
   ```

3. Publish to the VS Code Marketplace with `vsce publish`. This needs a personal access token for the `CppcheckSolutionsAB` publisher. You can also upload the .vsix manually to VS Code Marketplace if you go to the manage view, find the extension and under `more actions...` click update.
4. Publish to [Open VSX](https://open-vsx.org/). This is done through navigating to the `publish` page and simply uploading the .vsix file. The website will identify the extension and treat it as a new version of the already existing extension.
5. Create a GitHub release with a tag named after the version (e.g. `1.0.17`) and the generated release notes ("What's Changed").

## History

The boilerplate was created with the VS Code extension generator (`npm install -g yo generator-code` and `yo code`).
