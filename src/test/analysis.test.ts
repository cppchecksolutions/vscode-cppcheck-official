import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { writeSuppressionToProjectFile } from '../util/files';
import { findWorkspaceRoot } from '../util/path';

// These tests run the real extension in the VS Code test host, but replace the cppcheck executable with a small
// fake that records how it was called and prints a prepared XML report on stderr (like cppcheck --xml does).
// This keeps the tests fast, deterministic and independent of an installed cppcheck.

interface Location {
	file: string;
	line: number;
	column?: number;
	info?: string;
}

interface CppcheckError {
	id: string;
	severity: string;
	msg: string;
	// Like in cppcheck's XML output the last location is the main location
	locations: Location[];
	symbol?: string;
}

const fakeCppcheckSource = `
    const fs = require('fs');
    const args = process.argv.slice(2);
    if (args.includes('--version')) {
        console.log(process.env.FAKE_CPPCHECK_VERSION || 'Cppcheck 2.99');
        process.exit(0);
    }
    process.on('exit', () => fs.appendFileSync(process.env.FAKE_CPPCHECK_LOG + '.done', 'done\\n'));
    fs.appendFileSync(process.env.FAKE_CPPCHECK_LOG, JSON.stringify(args) + '\\n');
    process.stderr.write(fs.readFileSync(process.env.FAKE_CPPCHECK_XML, 'utf8'));
    if (process.env.FAKE_CPPCHECK_STDOUT) {
        process.stdout.write(process.env.FAKE_CPPCHECK_STDOUT);
    }
    process.exitCode = Number(process.env.FAKE_CPPCHECK_EXIT || 0);
`;

const sampleSource = [
	'int main() {',
	'    int* p = nullptr;',
	'    *p = 1;',
	'    int x;',
	'    return x;',
	'}',
	''
].join('\n');

function escapeXml(text: string) {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toPosix(p: string) {
	return p.replaceAll('\\', '/');
}

function buildXml(errors: CppcheckError[]) {
	const body = errors.map(e => {
		const locations = e.locations.map(l =>
			`<location file="${escapeXml(toPosix(l.file))}" line="${l.line}" column="${l.column ?? 5}"` +
			(l.info ? ` info="${escapeXml(l.info)}"` : '') + '/>'
		).join('');
		const symbol = e.symbol ? `<symbol>${escapeXml(e.symbol)}</symbol>` : '';
		return `<error id="${e.id}" severity="${e.severity}" msg="${escapeXml(e.msg)}" verbose="${escapeXml(e.msg)}">${locations}${symbol}</error>`;
	}).join('');
	return `<?xml version="1.0" encoding="UTF-8"?><results version="2"><cppcheck version="2.99"/><errors>${body}</errors></results>`;
}

async function waitFor(condition: () => boolean, description: string, timeoutMs = 20000) {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) {
			assert.fail(`Timed out waiting for: ${description}`);
		}
		await new Promise(resolve => setTimeout(resolve, 50));
	}
}

function cppcheckDiagnostics(uri: vscode.Uri) {
	return vscode.languages.getDiagnostics(uri).filter(d => d.source === 'cppcheck');
}

function codeOf(diagnostic: vscode.Diagnostic) {
	const code = diagnostic.code;
	return typeof code === 'object' ? String(code.value) : String(code);
}

suite('Analysis', function () {
	this.timeout(60000);

	let toolDir: string;
	let fakeCppcheck: string;
	let logFile: string;
	let xmlFile: string;
	let workDir: string;
	let hiddenTypes: string[];
	const window = vscode.window as unknown as { showQuickPick: unknown };
	const originalShowQuickPick = window.showQuickPick;

	function invocations(): string[][] {
		if (!fs.existsSync(logFile)) {
			return [];
		}
		return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
	}

	function lastInvocation() {
		const all = invocations();
		assert.ok(all.length > 0, 'cppcheck has not been called');
		return all[all.length - 1];
	}

	function setReport(errors: CppcheckError[]) {
		fs.writeFileSync(xmlFile, buildXml(errors));
	}

	function writeWorkFile(name: string, content = sampleSource) {
		const file = path.join(workDir, name);
		fs.writeFileSync(file, content);
		return file;
	}

    function writeCompileCommands(project: string, files: string[]) {
        fs.writeFileSync(project, JSON.stringify(files.map(file => ({
            directory: workDir,
            file,
            command: `c++ -c ${file}`
        }))));
    }

	// Opens the file in an editor and saves a modified version of it, which triggers an analysis
	async function openAndAnalyze(file: string) {
		const document = await vscode.workspace.openTextDocument(file);
		await vscode.window.showTextDocument(document);
		const callsBefore = invocations().length;
		const edit = new vscode.WorkspaceEdit();
		edit.insert(document.uri, document.positionAt(document.getText().length), '\n');
		await vscode.workspace.applyEdit(edit);
		await document.save();
		await waitFor(() => invocations().length > callsBefore, 'cppcheck to be called');
		await waitForAnalysesToSettle();
        return document;
	}

	async function getCodeActions(document: vscode.TextDocument, diagnostic: vscode.Diagnostic) {
		const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
			'vscode.executeCodeActionProvider', document.uri, diagnostic.range, vscode.CodeActionKind.QuickFix.value
		);
		return actions ?? [];
	}

	async function discardChanges(document: vscode.TextDocument) {
		if (document.isDirty) {
			await vscode.window.showTextDocument(document);
			await vscode.commands.executeCommand('workbench.action.files.revert');
		}
	}

	function stubQuickPick(value: unknown) {
		window.showQuickPick = () => Promise.resolve(value);
	}

    function finishedCount() {
        const done = logFile + '.done';
        return fs.existsSync(done) ? fs.readFileSync(done, 'utf8').split('\n').filter(Boolean).length : 0;
    }

    // Waits until every started cppcheck has exited and nothing new has started for a moment.
    // The settle time covers the extension's work after the process exits (XML parsing, mapping).
    async function waitForAnalysesToSettle(settleMs = 100) {
        let lastStarted = -1;
        let stableSince = Date.now();
        await waitFor(() => {
            const started = invocations().length;
            if (started !== lastStarted || started !== finishedCount()) {
                lastStarted = started;
                stableSince = Date.now();
                return false;
            }
            return Date.now() - stableSince >= settleMs;
        }, 'cppcheck analyses to settle');
    }

	async function setSetting(key: string, value: unknown) {
		await vscode.workspace.getConfiguration('cppcheck-official').update(key, value, vscode.ConfigurationTarget.Global);
	}

	const hasWorkspace = () => (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
	const cppcheckConfig = () => vscode.workspace.getConfiguration('cppcheck-official');
	const emptyProject = '<?xml version="1.0"?>\n<project version="1">\n    <paths>\n        <dir name="."/>\n    </paths>\n</project>\n';

	// Stubs of vscode.window functions, restored in teardown
	const stubbedWindowFunctions = new Map<string, unknown>();
	function stubWindow(name: string, implementation: (...args: any[]) => unknown) {
		const target = vscode.window as unknown as Record<string, unknown>;
		if (!stubbedWindowFunctions.has(name)) {
			stubbedWindowFunctions.set(name, target[name]);
		}
		target[name] = implementation;
	}
	function restoreWindow() {
		const target = vscode.window as unknown as Record<string, unknown>;
		for (const [name, original] of stubbedWindowFunctions) {
			target[name] = original;
		}
		stubbedWindowFunctions.clear();
	}
	function captureMessages() {
		const messages = { error: [] as string[], info: [] as string[], warning: [] as string[] };
		stubWindow('showErrorMessage', (m: string) => { messages.error.push(m); return Promise.resolve(undefined); });
		stubWindow('showInformationMessage', (m: string) => { messages.info.push(m); return Promise.resolve(undefined); });
		stubWindow('showWarningMessage', (m: string) => { messages.warning.push(m); return Promise.resolve(undefined); });
		return messages;
	}

	// For asserting that something did NOT happen
	const quietPeriod = () => new Promise(resolve => setTimeout(resolve, 500));

	// Like openAndAnalyze, but does not wait for cppcheck to be called
	async function editAndSave(file: string) {
		const document = await vscode.workspace.openTextDocument(file);
		await vscode.window.showTextDocument(document);
		const edit = new vscode.WorkspaceEdit();
		edit.insert(document.uri, document.positionAt(document.getText().length), '\n');
		await vscode.workspace.applyEdit(edit);
		await document.save();
		return document;
	}

	// The version check is not awaited by the extension, so a change in version output only takes effect on a later run
	async function runUntilPremiumFlag(run: () => Promise<unknown>, expected: boolean) {
		for (let attempt = 0; attempt < 10; attempt++) {
			await run();
			if (lastInvocation().includes('--premium=safety-off') === expected) {
				return;
			}
		}
		assert.fail(`--premium=safety-off was ${expected ? 'never' : 'still'} passed to cppcheck`);
	}

	async function analyzeWithProjectFile(projectContent: string) {
		const file = writeWorkFile('main.cpp');
		const project = path.join(workDir, 'project-file.cppcheck');
		fs.writeFileSync(project, projectContent);
		await setSetting('arguments', `--project=${project}`);
		setReport([
			{ id: 'nullPointer', severity: 'error', msg: 'Null pointer dereference', locations: [{ file, line: 3 }] },
			{ id: 'uninitvar', severity: 'error', msg: 'Uninitialized variable: x', locations: [{ file, line: 5 }], symbol: 'x' },
		]);
		const document = await openAndAnalyze(file);
		await waitFor(() => cppcheckDiagnostics(document.uri).length === 2, 'two diagnostics');
		return { project, document };
	}

	// Positions that cppcheck can report but that do not exist in the file
	function positionReport(file: string): CppcheckError[] {
		return [
			{ id: 'unreadVariable', severity: 'style', msg: 'Line outside the file', locations: [{ file, line: 999 }] },
			{ id: 'knownConditionTrueFalse', severity: 'warning', msg: 'Line is not a number', locations: [{ file, line: NaN }] },
			{ id: 'syntaxError', severity: 'error', msg: 'Critical, line is zero', locations: [{ file, line: 0, column: 0 }] },
			{ id: 'nullPointer', severity: 'error', msg: 'Column outside the line', locations: [{ file, line: 3, column: 500 }] },
			{ id: 'uninitvar', severity: 'error', msg: 'Column is not a number', locations: [{ file, line: 5, column: NaN }] },
		];
	}
	function assertPositions(uri: vscode.Uri) {
		const positionOf = (code: string) => {
			const diagnostic = cppcheckDiagnostics(uri).find(d => codeOf(d) === code);
			assert.ok(diagnostic, `missing ${code}`);
			return [diagnostic.range.start.line, diagnostic.range.start.character];
		};
		// Non critical warnings with an impossible line are dropped, critical ones are moved to the start of the file
		assert.deepStrictEqual(cppcheckDiagnostics(uri).map(codeOf).sort(), ['nullPointer', 'syntaxError', 'uninitvar']);
		assert.deepStrictEqual(positionOf('syntaxError'), [0, 0]);
		// An impossible column is moved to the start of the line
		assert.deepStrictEqual(positionOf('nullPointer'), [2, 0]);
		assert.deepStrictEqual(positionOf('uninitvar'), [4, 0]);
	}

	suiteSetup(async function () {
		if (process.platform === 'win32') {
			// The fake executable is a shell script, which cannot be spawned directly on Windows
			this.skip();
		}
		await vscode.extensions.getExtension('CppcheckSolutionsAB.cppcheck-official')?.activate();

		toolDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cppcheck-fake-')));
		const script = path.join(toolDir, 'fake-cppcheck.js');
		fs.writeFileSync(script, fakeCppcheckSource);
		fakeCppcheck = path.join(toolDir, 'cppcheck');
		fs.writeFileSync(fakeCppcheck, `#!/bin/sh\nexec node "${script}" "$@"\n`, { mode: 0o755 });
		logFile = path.join(toolDir, 'calls.log');
		xmlFile = path.join(toolDir, 'report.xml');
		process.env.FAKE_CPPCHECK_LOG = logFile;
		process.env.FAKE_CPPCHECK_XML = xmlFile;

		await setSetting('path', fakeCppcheck);
	});

	suiteTeardown(async () => {
		await setSetting('path', undefined);
		await setSetting('arguments', undefined);
		await setSetting('minSeverity', undefined);
		if (toolDir) {
			fs.rmSync(toolDir, { recursive: true, force: true });
		}
	});

	setup(async () => {
		workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cppcheck-work-')));
		hiddenTypes = [];
        fs.rmSync(logFile, { force: true });
		fs.rmSync(logFile + '.done', { force: true });
		await setSetting('arguments', '');
		await setSetting('minSeverity', 'info');
	});

	teardown(async () => {
		restoreWindow();
		delete process.env.FAKE_CPPCHECK_VERSION;
		delete process.env.FAKE_CPPCHECK_EXIT;
		delete process.env.FAKE_CPPCHECK_STDOUT;
		await setSetting('path', fakeCppcheck);
		await setSetting('enable', undefined);
		if (hasWorkspace()) {
			await cppcheckConfig().update('minSeverity', undefined, vscode.ConfigurationTarget.Workspace);
			await cppcheckConfig().update('path', undefined, vscode.ConfigurationTarget.Workspace);
		}

		// Hidden warning types are remembered by the extension, make sure they do not leak into the next test
		for (const type of hiddenTypes) {
			stubQuickPick({ label: type, value: type });
			await vscode.commands.executeCommand('cppcheck-official.revealHiddenTypes');
		}
		window.showQuickPick = originalShowQuickPick;
		for (const document of vscode.workspace.textDocuments) {
			await discardChanges(document);
		}
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await waitForAnalysesToSettle();
        fs.rmSync(workDir, { recursive: true, force: true });
	});

	suite('Regular analysis', () => {
		test('Without project file analyzes the single file and shows its warnings', async () => {
			const file = writeWorkFile('main.cpp');
			setReport([
				{ id: 'nullPointer', severity: 'error', msg: 'Null pointer dereference', locations: [{ file, line: 3 }] },
				{ id: 'uninitvar', severity: 'error', msg: 'Uninitialized variable: x', locations: [{ file, line: 5 }], symbol: 'x' },
			]);

			const document = await openAndAnalyze(file);
			await waitFor(() => cppcheckDiagnostics(document.uri).length === 2, 'two diagnostics');

			const args = lastInvocation();
			assert.ok(args.includes('--xml'));
			assert.ok(args.includes('--enable=all'));
			assert.ok(args.includes('--inline-suppr'));
			assert.ok(args.includes('--suppress=unusedFunction'));
			assert.ok(args.includes('--suppress=missingInclude'));
			assert.ok(args.includes(toPosix(file)));
			assert.ok(!args.some(a => a.startsWith('--project')));
			assert.ok(!args.some(a => a.startsWith('--file-filter')));

			const diagnostics = cppcheckDiagnostics(document.uri).sort((a, b) => a.range.start.line - b.range.start.line);
			assert.deepStrictEqual(diagnostics.map(codeOf), ['nullPointer', 'uninitvar']);
			assert.deepStrictEqual(diagnostics.map(d => d.range.start.line), [2, 4]);
			assert.strictEqual(diagnostics[0].message, 'Null pointer dereference');
			assert.strictEqual(diagnostics[0].severity, vscode.DiagnosticSeverity.Error);
		});

		test('Does not offer project file suppressions without project file', async () => {
			const file = writeWorkFile('main.cpp');
			setReport([{ id: 'nullPointer', severity: 'error', msg: 'Null pointer dereference', locations: [{ file, line: 3 }] }]);

			const document = await openAndAnalyze(file);
			await waitFor(() => cppcheckDiagnostics(document.uri).length === 1, 'one diagnostic');

			const actions = await getCodeActions(document, cppcheckDiagnostics(document.uri)[0]);
			assert.ok(actions.some(a => a.title.startsWith('Hide this nullPointer')));
			assert.ok(!actions.some(a => a.title.includes('(in project file)')));
			await assert.rejects(() => Promise.resolve(vscode.commands.executeCommand('cppcheck-official.suppressWarningAll', 'nullPointer')));
		});
	});

	suite('Project files', () => {
		test('compile_commands.json: regular analysis filters on the analyzed file', async () => {
			const file = writeWorkFile('main.cpp');
			const project = path.join(workDir, 'compile_commands.json');
			writeCompileCommands(project, [file]);
			await setSetting('arguments', `--project=${project}`);
			setReport([{ id: 'nullPointer', severity: 'error', msg: 'Null pointer dereference', locations: [{ file, line: 3 }] }]);

			const document = await openAndAnalyze(file);
			await waitFor(() => cppcheckDiagnostics(document.uri).length === 1, 'one diagnostic');

			const args = lastInvocation();
			assert.ok(args.includes(`--project=${project}`));
			assert.ok(args.includes(`--file-filter=${toPosix(file)}`));
			assert.ok(!args.includes(toPosix(file)), 'file must not be passed as a positional argument');
			assert.ok(!args.includes('--suppress=unusedFunction'));
		});

		test('compile_commands.json: does not offer project file suppressions', async () => {
			const file = writeWorkFile('main.cpp');
			const project = path.join(workDir, 'compile_commands.json');
			writeCompileCommands(project, [file]);
			await setSetting('arguments', `--project=${project}`);
			setReport([{ id: 'nullPointer', severity: 'error', msg: 'Null pointer dereference', locations: [{ file, line: 3 }] }]);

			const document = await openAndAnalyze(file);
			await waitFor(() => cppcheckDiagnostics(document.uri).length === 1, 'one diagnostic');

			const actions = await getCodeActions(document, cppcheckDiagnostics(document.uri)[0]);
			assert.ok(!actions.some(a => a.title.includes('(in project file)')));
		});

		test('compile_commands.json: ignores warnings whose main location is in another file', async () => {
			const file = writeWorkFile('main.cpp');
			const other = writeWorkFile('other.cpp');
			const project = path.join(workDir, 'compile_commands.json');
			writeCompileCommands(project, [file]);
			await setSetting('arguments', `--project=${project}`);
			setReport([
				{ id: 'nullPointer', severity: 'error', msg: 'Null pointer dereference', locations: [{ file, line: 3 }] },
				{ id: 'uninitvar', severity: 'error', msg: 'Uninitialized variable: x', locations: [{ file: other, line: 5 }] },
			]);

			const document = await openAndAnalyze(file);
			await waitFor(() => cppcheckDiagnostics(document.uri).length === 1, 'one diagnostic');
			assert.strictEqual(cppcheckDiagnostics(vscode.Uri.file(other)).length, 0);
		});

        test('compile_commands.json: relative directory entries are resolved like cppcheck does', async () => {
            const file = writeWorkFile('main.cpp');
            const project = path.join(workDir, 'compile_commands.json');
            const base = findWorkspaceRoot() ?? process.cwd();
            fs.writeFileSync(project, JSON.stringify([{
                directory: path.relative(base, workDir),
                file: 'main.cpp',
                command: 'c++ -c main.cpp'
            }]));
            await setSetting('arguments', `--project=${project}`);
            setReport([{ id: 'nullPointer', severity: 'error', msg: 'Null pointer dereference', locations: [{ file, line: 3 }] }]);

            const document = await openAndAnalyze(file);
            await waitFor(() => cppcheckDiagnostics(document.uri).length === 1, 'one diagnostic');
        });

		test('.cppcheck: regular analysis passes the project file and offers project suppressions', async () => {
			const file = writeWorkFile('main.cpp');
			const project = path.join(workDir, 'project-file.cppcheck');
			fs.writeFileSync(project, '<?xml version="1.0"?>\n<project version="1">\n    <paths>\n        <dir name="."/>\n    </paths>\n</project>\n');
			await setSetting('arguments', `--project=${project}`);
			setReport([{ id: 'nullPointer', severity: 'error', msg: 'Null pointer dereference', locations: [{ file, line: 3 }] }]);

			const document = await openAndAnalyze(file);
			await waitFor(() => cppcheckDiagnostics(document.uri).length === 1, 'one diagnostic');

			const args = lastInvocation();
			assert.ok(args.includes(`--project=${project}`));
			assert.ok(args.includes(`--file-filter=${toPosix(file)}`));

			const actions = await getCodeActions(document, cppcheckDiagnostics(document.uri)[0]);
			assert.ok(actions.some(a => a.title === 'Suppress warning type nullPointer universally (in project file)'));
			assert.ok(actions.some(a => a.title.startsWith('Suppress warning nullPointer based on file')));
		});
	});

	suite('Full analysis', () => {
		async function runFullAnalysis(threads: string) {
			stubQuickPick({ label: threads, value: threads });
			await vscode.commands.executeCommand('cppcheck-official.runFullAnalysis');
		}

		async function useCompileCommands() {
			const project = path.join(workDir, 'compile_commands.json');
			fs.writeFileSync(project, '[]');
			await setSetting('arguments', `--project=${project}`);
			return project;
		}

		test('compile_commands.json: analyzes the whole project', async () => {
			const first = writeWorkFile('first.cpp');
			const second = writeWorkFile('second.cpp');
			const project = path.join(workDir, 'compile_commands.json');
			fs.writeFileSync(project, '[]');
			await setSetting('arguments', `--project=${project}`);
			setReport([
				{ id: 'nullPointer', severity: 'error', msg: 'Null pointer dereference', locations: [{ file: first, line: 3 }] },
				{ id: 'uninitvar', severity: 'error', msg: 'Uninitialized variable: x', locations: [{ file: second, line: 5 }] },
			]);

			await runFullAnalysis('-j2');

			const args = lastInvocation();
			assert.ok(args.includes('-j2'));
			assert.ok(args.includes(`--project=${project}`));
			assert.ok(args.includes('--inline-suppr'));
			assert.ok(!args.some(a => a.startsWith('--file-filter')));
			assert.deepStrictEqual(cppcheckDiagnostics(vscode.Uri.file(first)).map(codeOf), ['nullPointer']);
			assert.deepStrictEqual(cppcheckDiagnostics(vscode.Uri.file(second)).map(codeOf), ['uninitvar']);
		});

		test('.cppcheck: analyzes the whole project and offers project suppressions', async () => {
			const first = writeWorkFile('first.cpp');
			const second = writeWorkFile('second.cpp');
			const project = path.join(workDir, 'project-file.cppcheck');
			fs.writeFileSync(project, '<?xml version="1.0"?>\n<project version="1">\n</project>\n');
			await setSetting('arguments', `--project=${project}`);
			setReport([
				{ id: 'nullPointer', severity: 'error', msg: 'Null pointer dereference', locations: [{ file: first, line: 3 }] },
				{ id: 'uninitvar', severity: 'error', msg: 'Uninitialized variable: x', locations: [{ file: second, line: 5 }] },
			]);

			await runFullAnalysis('-j1');

			assert.ok(lastInvocation().includes('-j1'));
			assert.ok(lastInvocation().includes(`--project=${project}`));
			assert.strictEqual(cppcheckDiagnostics(vscode.Uri.file(first)).length, 1);
			assert.strictEqual(cppcheckDiagnostics(vscode.Uri.file(second)).length, 1);

			const document = await vscode.workspace.openTextDocument(first);
			const actions = await getCodeActions(document, cppcheckDiagnostics(document.uri)[0]);
			assert.ok(actions.some(a => a.title.includes('(in project file)')));
		});

		test('replaces warnings from earlier analyses', async () => {
			const first = writeWorkFile('first.cpp');
			const second = writeWorkFile('second.cpp');
			const project = path.join(workDir, 'compile_commands.json');
			fs.writeFileSync(project, '[]');
			await setSetting('arguments', `--project=${project}`);
			setReport([{ id: 'nullPointer', severity: 'error', msg: 'Null pointer dereference', locations: [{ file: first, line: 3 }] }]);
			await runFullAnalysis('-j1');
			assert.strictEqual(cppcheckDiagnostics(vscode.Uri.file(first)).length, 1);
			setReport([{ id: 'uninitvar', severity: 'error', msg: 'Uninitialized variable: x', locations: [{ file: second, line: 5 }] }]);
			await runFullAnalysis('-j1');

			assert.strictEqual(cppcheckDiagnostics(vscode.Uri.file(first)).length, 0);
			assert.strictEqual(cppcheckDiagnostics(vscode.Uri.file(second)).length, 1);
		});

		test('fails without project file', async () => {
			await setSetting('arguments', '');
			stubQuickPick({ label: '-j1', value: '-j1' });
			await assert.rejects(() => Promise.resolve(vscode.commands.executeCommand('cppcheck-official.runFullAnalysis')));
		});

		test('Cancelling the thread selection does not start cppcheck', async () => {
			await useCompileCommands();
			stubQuickPick(undefined);
			await vscode.commands.executeCommand('cppcheck-official.runFullAnalysis');
			assert.strictEqual(invocations().length, 0);
		});

		test('Fails with messages when cppcheck cannot be started', async () => {
			await useCompileCommands();
			const messages = captureMessages();
			await setSetting('path', path.join(workDir, 'no-such-cppcheck'));
			await assert.rejects(runFullAnalysis('-j1'));
			await waitFor(() => messages.error.some(m => m.includes('Could not find or run')), 'the version check to fail');
			assert.ok(messages.error.some(m => m.includes('failed to start')));
		});

		test('Failing cppcheck: the message from stdout is shown together with the command', async () => {
			await useCompileCommands();
			setReport([]);
			process.env.FAKE_CPPCHECK_EXIT = '2';
			process.env.FAKE_CPPCHECK_STDOUT = 'cppcheck: error: something went wrong\n';
			const messages = captureMessages();
			await runFullAnalysis('-j1');
			assert.strictEqual(messages.error.length, 1);
			assert.ok(messages.error[0].startsWith('cppcheck: error: something went wrong, Command: '));
			assert.ok(messages.error[0].includes('-j1'));
		});

		test('Errors without a location are ignored and unreachable files are announced', async () => {
			const file = writeWorkFile('first.cpp');
			await useCompileCommands();
			const messages = captureMessages();
			setReport([
				{ id: 'checkersReport', severity: 'information', msg: 'No location', locations: [] },
				{ id: 'uninitvar', severity: 'error', msg: 'Uninitialized variable: x', locations: [{ file: path.join(workDir, 'missing.cpp'), line: 5 }] },
				{ id: 'nullPointer', severity: 'error', msg: 'Null pointer dereference', locations: [{ file, line: 3 }] },
			]);
			await runFullAnalysis('-j1');

			assert.deepStrictEqual(cppcheckDiagnostics(vscode.Uri.file(file)).map(codeOf), ['nullPointer']);
			assert.strictEqual(messages.info.length, 1);
			assert.ok(messages.info[0].includes('[uninitvar]'));
			assert.ok(messages.info[0].includes('Uninitialized variable: x'));
		});

		test('Impossible lines and columns are skipped, moved or clamped', async () => {
			const file = writeWorkFile('first.cpp');
			await useCompileCommands();
			setReport(positionReport(file));
			await runFullAnalysis('-j1');
			assertPositions(vscode.Uri.file(file));
		});

		test('Premium cppcheck gets --premium=safety-off', async () => {
			await useCompileCommands();
			setReport([]);
			process.env.FAKE_CPPCHECK_VERSION = 'Cppcheck Premium 25.8.0';
			try {
				await runUntilPremiumFlag(() => runFullAnalysis('-j1'), true);
			} finally {
				delete process.env.FAKE_CPPCHECK_VERSION;
				await runUntilPremiumFlag(() => runFullAnalysis('-j1'), false);
			}
		});
	});

	suite('Project file suppressions', () => {
		const projectWithoutSuppressions = '<?xml version="1.0"?>\n<project version="1">\n    <paths>\n        <dir name="."/>\n    </paths>\n</project>\n';

		test('Adds a suppressions block when the project file has none', async () => {
			const project = path.join(workDir, 'project-file.cppcheck');
			fs.writeFileSync(project, projectWithoutSuppressions);

			const success = await writeSuppressionToProjectFile(vscode.Uri.file(project), 'nullPointer');

			assert.ok(success);
			const content = fs.readFileSync(project, 'utf8');
			assert.match(content, /<suppressions>\s*<suppression>nullPointer<\/suppression>\s*<\/suppressions>\s*<\/project>/);
		});

		test('Adds to an existing suppressions block, with file and symbol name', async () => {
			const project = path.join(workDir, 'project-file.cppcheck');
			fs.writeFileSync(project, projectWithoutSuppressions);

			await writeSuppressionToProjectFile(vscode.Uri.file(project), 'nullPointer');
			await writeSuppressionToProjectFile(vscode.Uri.file(project), 'uninitvar', 'main.cpp', 'x');

			const content = fs.readFileSync(project, 'utf8');
			assert.strictEqual(content.match(/<suppressions>/g)?.length, 1);
			assert.ok(content.includes('<suppression>nullPointer</suppression>'));
			assert.ok(content.includes('<suppression file="main.cpp" symbolName="x">uninitvar</suppression>'));
			assert.ok(content.indexOf('nullPointer') < content.indexOf('uninitvar'));
		});

		test('Refuses project files that are not .cppcheck files', async () => {
			const project = path.join(workDir, 'compile_commands.json');
			fs.writeFileSync(project, '[]');
			await assert.rejects(writeSuppressionToProjectFile(vscode.Uri.file(project), 'nullPointer'));
		});

		test('Command writes the suppression to the project file used for the analysis', async () => {
			const file = writeWorkFile('main.cpp');
			const project = path.join(workDir, 'project-file.cppcheck');
			fs.writeFileSync(project, projectWithoutSuppressions);
			await setSetting('arguments', `--project=${project}`);
			setReport([{ id: 'nullPointer', severity: 'error', msg: 'Null pointer dereference', locations: [{ file, line: 3 }] }]);
			const document = await openAndAnalyze(file);
			await waitFor(() => cppcheckDiagnostics(document.uri).length === 1, 'one diagnostic');

			await vscode.commands.executeCommand('cppcheck-official.suppressWarningAll', 'nullPointer');

			assert.ok(fs.readFileSync(project, 'utf8').includes('<suppression>nullPointer</suppression>'));
		});
	});

	suite('Multiple locations', () => {
		const multiLocationError = (file: string): CppcheckError => ({
			id: 'nullPointerRedundantCheck',
			severity: 'warning',
			msg: 'Either the condition is redundant or there is possible null pointer dereference',
			// Last location is the main location
			locations: [
				{ file, line: 2, info: 'Assuming that condition is not redundant' },
				{ file, line: 3, info: 'Null pointer dereference' },
			],
		});

		test('Warning is placed at the main location with the other locations as related information', async () => {
			const file = writeWorkFile('main.cpp');
			setReport([multiLocationError(file)]);

			const document = await openAndAnalyze(file);
			await waitFor(() => cppcheckDiagnostics(document.uri).length === 1, 'one diagnostic');

			const diagnostic = cppcheckDiagnostics(document.uri)[0];
			assert.strictEqual(diagnostic.range.start.line, 2);
			const related = diagnostic.relatedInformation ?? [];
			assert.deepStrictEqual(
				related.map(r => [r.location.range.start.line, r.message]),
				[[2, 'Null pointer dereference'], [1, 'Assuming that condition is not redundant']]
			);
			assert.ok(related.every(r => r.location.uri.fsPath === document.uri.fsPath));
		});

		test('Inline suppression is inserted at the first location', async () => {
			const file = writeWorkFile('main.cpp');
			setReport([multiLocationError(file)]);
			const document = await openAndAnalyze(file);
			await waitFor(() => cppcheckDiagnostics(document.uri).length === 1, 'one diagnostic');

			const actions = await getCodeActions(document, cppcheckDiagnostics(document.uri)[0]);
			const suppress = actions.find(a => a.title.startsWith('Add comment that suppresses'));
			assert.ok(suppress?.edit);
			await vscode.workspace.applyEdit(suppress.edit);

			assert.strictEqual(document.lineAt(1).text, '    // cppcheck-suppress nullPointerRedundantCheck');
			assert.strictEqual(document.lineAt(2).text, '    int* p = nullptr;');
			await discardChanges(document);
		});
	});

	suite('Hiding warnings', () => {
		let document: vscode.TextDocument;

		setup(async () => {
			const file = writeWorkFile('main.cpp');
			setReport([
				{ id: 'nullPointer', severity: 'error', msg: 'Null pointer dereference', locations: [{ file, line: 3 }] },
				{ id: 'nullPointer', severity: 'error', msg: 'Null pointer dereference', locations: [{ file, line: 2 }] },
				{ id: 'uninitvar', severity: 'error', msg: 'Uninitialized variable: x', locations: [{ file, line: 5 }] },
			]);
			document = await openAndAnalyze(file);
			await waitFor(() => cppcheckDiagnostics(document.uri).length === 3, 'three diagnostics');
		});

		test('Hides a specific warning', async () => {
			const target = cppcheckDiagnostics(document.uri).find(d => codeOf(d) === 'nullPointer' && d.range.start.line === 2);
			assert.ok(target);

			await vscode.commands.executeCommand('cppcheck-official.hideWarning', document.uri, 'nullPointer', target.range);

			const remaining = cppcheckDiagnostics(document.uri);
			assert.deepStrictEqual(
				remaining.map(d => [codeOf(d), d.range.start.line]).sort(),
				[['nullPointer', 1], ['uninitvar', 4]]
			);
		});

		test('Hides all warnings of a type, also after a new analysis, and reveals them again', async () => {
			hiddenTypes.push('nullPointer');
			await vscode.commands.executeCommand('cppcheck-official.hideWarningType', 'nullPointer');
			assert.deepStrictEqual(cppcheckDiagnostics(document.uri).map(codeOf), ['uninitvar']);

			await openAndAnalyze(document.uri.fsPath);
			await waitFor(() => cppcheckDiagnostics(document.uri).length > 0, 'diagnostics after re-analysis');
			assert.deepStrictEqual(cppcheckDiagnostics(document.uri).map(codeOf), ['uninitvar']);

			stubQuickPick({ label: 'nullPointer', value: 'nullPointer' });
			await vscode.commands.executeCommand('cppcheck-official.revealHiddenTypes');
			hiddenTypes.length = 0;
			assert.strictEqual(cppcheckDiagnostics(document.uri).length, 3);
		});

		test('Code actions hide a warning and a warning type', async () => {
			const target = cppcheckDiagnostics(document.uri).find(d => codeOf(d) === 'uninitvar');
			assert.ok(target);
			const actions = await getCodeActions(document, target);

			const hideAction = actions.find(a => a.title === 'Hide this uninitvar warning');
			const hideTypeAction = actions.find(a => a.title === 'Hide all uninitvar warnings');
			assert.strictEqual(hideAction?.command?.command, 'cppcheck-official.hideWarning');
			assert.strictEqual(hideTypeAction?.command?.command, 'cppcheck-official.hideWarningType');

			hiddenTypes.push('uninitvar');
			await vscode.commands.executeCommand(hideTypeAction.command.command, ...(hideTypeAction.command.arguments ?? []));
			assert.deepStrictEqual(cppcheckDiagnostics(document.uri).map(codeOf), ['nullPointer', 'nullPointer']);
		});
	});

	suite('Severity filter', () => {
		const severityReport = (file: string): CppcheckError[] => [
			{ id: 'nullPointer', severity: 'error', msg: 'An error', locations: [{ file, line: 3 }] },
			{ id: 'knownConditionTrueFalse', severity: 'warning', msg: 'A warning', locations: [{ file, line: 2 }] },
			{ id: 'unreadVariable', severity: 'style', msg: 'A style issue', locations: [{ file, line: 4 }] },
			{ id: 'checkersReport', severity: 'information', msg: 'Some information', locations: [{ file, line: 5 }] },
		];

		async function visibleIdsWithMinSeverity(minSeverity: string) {
			const file = writeWorkFile('main.cpp');
			setReport(severityReport(file));
			await setSetting('minSeverity', minSeverity);
			const document = await openAndAnalyze(file);
			await waitFor(() => cppcheckDiagnostics(document.uri).length > 0, 'diagnostics');
			return cppcheckDiagnostics(document.uri).map(codeOf).sort();
		}

		test('info shows everything', async () => {
			assert.deepStrictEqual(
				await visibleIdsWithMinSeverity('info'),
				['checkersReport', 'knownConditionTrueFalse', 'nullPointer', 'unreadVariable']
			);
		});

		test('warning hides style and information', async () => {
			assert.deepStrictEqual(await visibleIdsWithMinSeverity('warning'), ['knownConditionTrueFalse', 'nullPointer']);
		});

		test('error shows only errors', async () => {
			assert.deepStrictEqual(await visibleIdsWithMinSeverity('error'), ['nullPointer']);
		});

		test('Is also applied to full analysis', async () => {
			const file = writeWorkFile('main.cpp');
			const project = path.join(workDir, 'compile_commands.json');
			fs.writeFileSync(project, '[]');
			await setSetting('arguments', `--project=${project}`);
			await setSetting('minSeverity', 'error');
			setReport(severityReport(file));

			stubQuickPick({ label: '-j1', value: '-j1' });
			await vscode.commands.executeCommand('cppcheck-official.runFullAnalysis');

			assert.deepStrictEqual(cppcheckDiagnostics(vscode.Uri.file(file)).map(codeOf), ['nullPointer']);
		});
	});

	suite('Inline comments', () => {
		test('Analysis is run with --inline-suppr', async () => {
			const file = writeWorkFile('main.cpp');
			setReport([]);
			await openAndAnalyze(file);
			assert.ok(lastInvocation().includes('--inline-suppr'));
		});

		test('Code action adds a suppression comment with the indentation of the line and hides the warning', async () => {
			const file = writeWorkFile('main.cpp');
			setReport([{ id: 'nullPointer', severity: 'error', msg: 'Null pointer dereference', locations: [{ file, line: 3 }] }]);
			const document = await openAndAnalyze(file);
			await waitFor(() => cppcheckDiagnostics(document.uri).length === 1, 'one diagnostic');

			const actions = await getCodeActions(document, cppcheckDiagnostics(document.uri)[0]);
			const suppress = actions.find(a => a.title === 'Add comment that suppresses this nullPointer warning');
			assert.ok(suppress?.edit);
			assert.ok(suppress.command);
			await vscode.workspace.applyEdit(suppress.edit);
			await vscode.commands.executeCommand(suppress.command.command, ...(suppress.command.arguments ?? []));

			assert.strictEqual(document.lineAt(2).text, '    // cppcheck-suppress nullPointer');
			assert.strictEqual(document.lineAt(3).text, '    *p = 1;');
			assert.strictEqual(cppcheckDiagnostics(document.uri).length, 0);
			await discardChanges(document);
		});

		test('No code actions are offered when the line has changed since the analysis', async () => {
			const file = writeWorkFile('main.cpp');
			setReport([{ id: 'nullPointer', severity: 'error', msg: 'Null pointer dereference', locations: [{ file, line: 3 }] }]);
			const document = await openAndAnalyze(file);
			await waitFor(() => cppcheckDiagnostics(document.uri).length === 1, 'one diagnostic');
			const diagnostic = cppcheckDiagnostics(document.uri)[0];

			const edit = new vscode.WorkspaceEdit();
			edit.replace(document.uri, document.lineAt(2).range, '    *p = 2;');
			await vscode.workspace.applyEdit(edit);

			assert.strictEqual((await getCodeActions(document, diagnostic)).filter(a => a.title.includes('nullPointer')).length, 0);
			await discardChanges(document);
		});
	});

	suite('Commands', () => {
	suite('browsePath', () => {
		let dialogOptions: vscode.OpenDialogOptions | undefined;
		function stubOpenDialog(result: vscode.Uri[] | undefined) {
			dialogOptions = undefined;
			stubWindow('showOpenDialog', (options: vscode.OpenDialogOptions) => {
				dialogOptions = options;
				return Promise.resolve(result);
			});
		}
		const browse = () => vscode.commands.executeCommand('cppcheck-official.browsePath');

		test('Cancelled dialog leaves the setting untouched', async () => {
			stubOpenDialog(undefined);
			await browse();
			assert.strictEqual(cppcheckConfig().get('path'), fakeCppcheck);
		});

		test('Empty selection leaves the setting untouched', async () => {
			stubOpenDialog([]);
			await browse();
			assert.strictEqual(cppcheckConfig().get('path'), fakeCppcheck);
		});

		test('Selected executable is saved and the dialog starts at the current path', async () => {
			const chosen = path.join(toolDir, 'other-cppcheck');
			stubOpenDialog([vscode.Uri.file(chosen)]);
			await browse();
			assert.strictEqual(dialogOptions?.defaultUri?.fsPath, fakeCppcheck);
			assert.strictEqual(dialogOptions?.canSelectFolders, false);
			assert.strictEqual(cppcheckConfig().inspect<string>('path')?.globalValue, chosen);
		});

		test('Dialog has no start location when no path is configured', async () => {
			await setSetting('path', '');
			stubOpenDialog(undefined);
			await browse();
			assert.strictEqual(dialogOptions?.defaultUri, undefined);
		});

		test('Warns when a workspace setting overrides the saved path', async function () {
			if (!hasWorkspace()) {
				this.skip();
			}
			await cppcheckConfig().update('path', fakeCppcheck, vscode.ConfigurationTarget.Workspace);
			const messages = captureMessages();
			stubOpenDialog([vscode.Uri.file(path.join(toolDir, 'other-cppcheck'))]);
			await browse();
			assert.strictEqual(messages.warning.length, 1);
			assert.ok(messages.warning[0].includes('overridden by the workspace setting'));
		});
	});

	suite('suppressWarningAll', () => {
		test('Suppression for a file and symbol is written and the user is told to re-analyze', async () => {
			const { project } = await analyzeWithProjectFile(emptyProject);
			const messages = captureMessages();
			await vscode.commands.executeCommand('cppcheck-official.suppressWarningAll', 'uninitvar', 'main.cpp', 'x');

			assert.ok(fs.readFileSync(project, 'utf8').includes('<suppression file="main.cpp" symbolName="x">uninitvar</suppression>'));
			assert.strictEqual(messages.info.length, 1);
			assert.ok(messages.info[0].includes('Suppression of uninitvar added to project file'));
			assert.ok(messages.info[0].includes(' for file main.cpp for symbol name x'));
			assert.ok(messages.info[0].includes('you have to re-analyze'));
		});

		test('A universal suppression does not ask for a re-analysis', async () => {
			await analyzeWithProjectFile(emptyProject);
			const messages = captureMessages();
			await vscode.commands.executeCommand('cppcheck-official.suppressWarningAll', 'nullPointer');
			assert.strictEqual(messages.info.length, 1);
			assert.ok(!messages.info[0].includes('re-analyze'));
		});

		test('Reports an error when the project file cannot be written', async () => {
			await analyzeWithProjectFile('not a project file');
			const messages = captureMessages();
			await vscode.commands.executeCommand('cppcheck-official.suppressWarningAll', 'nullPointer');
			assert.strictEqual(messages.error.length, 1);
			assert.ok(messages.error[0].includes('Failed to add suppression of nullPointer'));
		});
	});

	suite('suppressWarningAdvanced', () => {
		let project: string;
		let document: vscode.TextDocument;
		let inputOptions: vscode.InputBoxOptions | undefined;
		let quickPickItems: Array<{ label: string; value: string | null }> | undefined;

		function answer(file: string | undefined, symbol?: { label: string; value: string | null }) {
			inputOptions = undefined;
			quickPickItems = undefined;
			stubWindow('showInputBox', (options: vscode.InputBoxOptions) => { inputOptions = options; return Promise.resolve(file); });
			stubWindow('showQuickPick', (items: typeof quickPickItems) => { quickPickItems = items; return Promise.resolve(symbol); });
		}
		function run(code: string) {
			const diagnostic = cppcheckDiagnostics(document.uri).find(d => codeOf(d) === code);
			assert.ok(diagnostic);
			return vscode.commands.executeCommand('cppcheck-official.suppressWarningAdvanced', code, document, diagnostic);
		}
		const projectText = () => fs.readFileSync(project, 'utf8');

		setup(async () => {
			({ project, document } = await analyzeWithProjectFile(emptyProject));
		});

		test('Warning with a symbol asks for the file and the symbol', async () => {
			answer('src/main.cpp', { label: 'Symbol: x', value: 'x' });
			await run('uninitvar');
			assert.strictEqual(inputOptions?.value, document.fileName);
			assert.ok(inputOptions?.title?.includes('(1/2)'));
			assert.deepStrictEqual(quickPickItems?.map(i => i.value), ['x', null]);
			assert.ok(projectText().includes('<suppression file="src/main.cpp" symbolName="x">uninitvar</suppression>'));
		});

		test('"Not symbol specific" suppresses by file only', async () => {
			answer('src/main.cpp', { label: 'Not symbol specific', value: null });
			await run('uninitvar');
			assert.ok(projectText().includes('<suppression file="src/main.cpp">uninitvar</suppression>'));
		});

		test('Warning without a symbol only asks for the file', async () => {
			answer('src/main.cpp');
			await run('nullPointer');
			assert.ok(!inputOptions?.title?.includes('(1/2)'));
			assert.strictEqual(quickPickItems, undefined);
			assert.ok(projectText().includes('<suppression file="src/main.cpp">nullPointer</suppression>'));
		});

		test('Escape at the file prompt cancels', async () => {
			answer(undefined);
			await run('uninitvar');
			assert.strictEqual(quickPickItems, undefined);
			assert.ok(!projectText().includes('<suppressions>'));
		});

		test('Escape at the symbol prompt cancels', async () => {
			answer('src/main.cpp', undefined);
			await run('uninitvar');
			assert.ok(quickPickItems);
			assert.ok(!projectText().includes('<suppressions>'));
		});
	});

	suite('selectMinSeverity', () => {
		let offered: Array<{ description: string; value: string }> = [];
		function stubSelection(selection: unknown) {
			offered = [];
			stubWindow('showQuickPick', (items: typeof offered) => { offered = items; return Promise.resolve(selection); });
		}
		const select = () => vscode.commands.executeCommand('cppcheck-official.selectMinSeverity');

		test('Marks the current level in the list', async () => {
			for (const level of ['info', 'warning', 'error']) {
				await setSetting('minSeverity', level);
				stubSelection(undefined);
				await select();
				assert.deepStrictEqual(offered.map(i => i.value), ['info', 'warning', 'error']);
				assert.deepStrictEqual(offered.filter(i => i.description !== '').map(i => i.value), [level]);
			}
		});

		test('Cancelling keeps the setting', async () => {
			await setSetting('minSeverity', 'warning');
			stubSelection(undefined);
			await select();
			assert.strictEqual(cppcheckConfig().get('minSeverity'), 'warning');
		});

		test('Selected level is saved for the workspace and applied to the warnings', async function () {
			if (!hasWorkspace()) {
				this.skip();
			}
			const file = writeWorkFile('main.cpp');
			setReport([
				{ id: 'nullPointer', severity: 'error', msg: 'An error', locations: [{ file, line: 3 }] },
				{ id: 'unreadVariable', severity: 'style', msg: 'A style issue', locations: [{ file, line: 4 }] },
			]);
			const document = await openAndAnalyze(file);
			await waitFor(() => cppcheckDiagnostics(document.uri).length === 2, 'two diagnostics');

			stubSelection({ label: 'Error', value: 'error' });
			await select();

			assert.strictEqual(cppcheckConfig().inspect<string>('minSeverity')?.workspaceValue, 'error');
			assert.deepStrictEqual(cppcheckDiagnostics(document.uri).map(codeOf), ['nullPointer']);
		});
	});
});

	suite('Reading the report', () => {
		test('Errors without a location are ignored', async () => {
			const file = writeWorkFile('main.cpp');
			setReport([
				{ id: 'checkersReport', severity: 'information', msg: 'No location', locations: [] },
				{ id: 'nullPointer', severity: 'error', msg: 'Null pointer dereference', locations: [{ file, line: 3 }] },
			]);
			const document = await openAndAnalyze(file);
			await waitFor(() => cppcheckDiagnostics(document.uri).length === 1, 'one diagnostic');
			assert.deepStrictEqual(cppcheckDiagnostics(document.uri).map(codeOf), ['nullPointer']);
		});

		test('Impossible lines and columns are skipped, moved or clamped', async () => {
			const file = writeWorkFile('main.cpp');
			setReport(positionReport(file));
			const document = await openAndAnalyze(file);
			await waitFor(() => cppcheckDiagnostics(document.uri).length === 3, 'three diagnostics');
			assertPositions(document.uri);
		});

		test('Warnings in other files are shown there and removed together with the analyzed file', async () => {
			const file = writeWorkFile('main.cpp');
			const other = writeWorkFile('other.cpp');
			setReport([
				{ id: 'nullPointer', severity: 'error', msg: 'Null pointer dereference', locations: [{ file, line: 3 }] },
				{ id: 'uninitvar', severity: 'error', msg: 'Uninitialized variable: x', locations: [{ file: other, line: 5 }] },
			]);
			const document = await openAndAnalyze(file);
			await waitFor(() => cppcheckDiagnostics(vscode.Uri.file(other)).length === 1, 'warning in the other file');
			assert.strictEqual(cppcheckDiagnostics(document.uri).length, 1);

			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			await waitFor(
				() => cppcheckDiagnostics(vscode.Uri.file(other)).length === 0 && cppcheckDiagnostics(document.uri).length === 0,
				'warnings to be cleared'
			);
		});

		test('A location with only a file name is matched against the analyzed file', async () => {
			const file = writeWorkFile('main.cpp');
			setReport([{ id: 'nullPointer', severity: 'error', msg: 'Null pointer dereference', locations: [{ file: 'main.cpp', line: 3 }] }]);
			const document = await openAndAnalyze(file);
			await waitFor(() => cppcheckDiagnostics(document.uri).length === 1, 'one diagnostic');
			assert.strictEqual(cppcheckDiagnostics(document.uri)[0].range.start.line, 2);
		});

		test('A warning in a file that cannot be opened is dropped', async () => {
			const file = writeWorkFile('main.cpp');
			const missing = path.join(workDir, 'missing.cpp');
			setReport([
				{ id: 'uninitvar', severity: 'error', msg: 'Uninitialized variable: x', locations: [{ file: missing, line: 5 }] },
				{ id: 'nullPointer', severity: 'error', msg: 'Null pointer dereference', locations: [{ file, line: 3 }] },
			]);
			const document = await openAndAnalyze(file);
			await waitFor(() => cppcheckDiagnostics(document.uri).length === 1, 'one diagnostic');
			assert.strictEqual(cppcheckDiagnostics(vscode.Uri.file(missing)).length, 0);
		});

		test('compile_commands.json: critical warnings in other files are still shown', async () => {
			const file = writeWorkFile('main.cpp');
			const other = writeWorkFile('other.cpp');
			const project = path.join(workDir, 'compile_commands.json');
			writeCompileCommands(project, [file]);
			await setSetting('arguments', `--project=${project}`);
			setReport([{ id: 'syntaxError', severity: 'error', msg: 'Syntax error', locations: [{ file: other, line: 3 }] }]);
			await openAndAnalyze(file);
			await waitFor(() => cppcheckDiagnostics(vscode.Uri.file(other)).length === 1, 'critical warning in the other file');
		});
	});

	suite('Failures', () => {
		test('Failing cppcheck: the message from stdout is shown together with the command', async () => {
			const file = writeWorkFile('main.cpp');
			setReport([]);
			process.env.FAKE_CPPCHECK_EXIT = '2';
			process.env.FAKE_CPPCHECK_STDOUT = 'cppcheck: error: something went wrong\n';
			const messages = captureMessages();
			await openAndAnalyze(file);
			await waitFor(() => messages.error.length > 0, 'an error message');
			assert.ok(messages.error[0].startsWith('cppcheck: error: something went wrong, Command: '));
			assert.ok(messages.error[0].includes(toPosix(file)));
		});

		test('Failing cppcheck without output: generic message', async () => {
			const file = writeWorkFile('main.cpp');
			setReport([]);
			process.env.FAKE_CPPCHECK_EXIT = '1';
			const messages = captureMessages();
			await openAndAnalyze(file);
			await waitFor(() => messages.error.length > 0, 'an error message');
			assert.ok(messages.error[0].startsWith('Cppcheck failed with code 1 (unknown error), Command: '));
		});

		test('Missing executable: both the version check and the start fail', async () => {
			// handleDocument rejects here, which the extension does not catch. VS Code logs it as an unhandled rejection.
			const file = writeWorkFile('main.cpp');
			const messages = captureMessages();
			await setSetting('path', path.join(workDir, 'no-such-cppcheck'));
			await editAndSave(file);
			await waitFor(
				() => messages.error.some(m => m.includes('Could not find or run')) && messages.error.some(m => m.includes('failed to start')),
				'both error messages'
			);
		});
	});

	suite('When files are analyzed', () => {
		test('Files that are not C or C++ are ignored', async () => {
			const file = writeWorkFile('notes.txt', 'just text\n');
			setReport([]);
			await editAndSave(file);
			await quietPeriod();
			assert.strictEqual(invocations().length, 0);
		});

		test('An unchanged file is not analyzed again when it is shown again', async () => {
			const first = writeWorkFile('first.cpp');
			const second = writeWorkFile('second.cpp');
			setReport([]);
			const document = await openAndAnalyze(first);
			await openAndAnalyze(second);
			const calls = invocations().length;

			await vscode.window.showTextDocument(document);
			await quietPeriod();
			assert.strictEqual(invocations().length, calls);
		});

		test('Closing a file clears its warnings and it is analyzed again when reopened', async () => {
			const file = writeWorkFile('main.cpp');
			setReport([{ id: 'nullPointer', severity: 'error', msg: 'Null pointer dereference', locations: [{ file, line: 3 }] }]);
			const document = await openAndAnalyze(file);
			await waitFor(() => cppcheckDiagnostics(document.uri).length === 1, 'one diagnostic');

			await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
			await waitFor(() => cppcheckDiagnostics(document.uri).length === 0, 'warnings to be cleared');

			const calls = invocations().length;
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
			await waitFor(() => invocations().length > calls, 'the reopened file to be analyzed');
			await waitFor(() => cppcheckDiagnostics(document.uri).length === 1, 'warning to come back');
		});

		test('Disabling the extension clears the warnings of changed files and stops analyses', async () => {
			const file = writeWorkFile('main.cpp');
			setReport([{ id: 'nullPointer', severity: 'error', msg: 'Null pointer dereference', locations: [{ file, line: 3 }] }]);
			const document = await openAndAnalyze(file);
			await waitFor(() => cppcheckDiagnostics(document.uri).length === 1, 'one diagnostic');
			const calls = invocations().length;

			await setSetting('enable', false);
			await editAndSave(file);

			await waitFor(() => cppcheckDiagnostics(document.uri).length === 0, 'warnings to be cleared');
			await quietPeriod();
			assert.strictEqual(invocations().length, calls);
		});

		test('Files in a preview tab are analyzed after a delay and cleared when no longer viewed', async () => {
			const first = writeWorkFile('first.cpp');
			const second = writeWorkFile('second.cpp');
			setReport([{ id: 'nullPointer', severity: 'error', msg: 'Null pointer dereference', locations: [{ file: first, line: 3 }] }]);

			// The extension waits 10 seconds before analyzing a previewed file, shorten that for the test
			const timers = globalThis as unknown as { setTimeout: typeof setTimeout };
			const originalSetTimeout = timers.setTimeout;
			const callSetTimeout = originalSetTimeout as unknown as (...args: unknown[]) => unknown;
			timers.setTimeout = ((handler: unknown, ms?: number, ...args: unknown[]) =>
				callSetTimeout(handler, ms === 10000 ? 20 : ms, ...args)) as unknown as typeof setTimeout;
			try {
				const document = await vscode.workspace.openTextDocument(first);
				await vscode.window.showTextDocument(document, { preview: true });
				assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview, 'the file is expected to open in a preview tab');
				await waitFor(() => cppcheckDiagnostics(document.uri).length === 1, 'warning in the previewed file');

				setReport([]);
				await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(second), { preview: false });
				await waitFor(() => cppcheckDiagnostics(document.uri).length === 0, 'warnings of the previewed file to be cleared');
			} finally {
				timers.setTimeout = originalSetTimeout;
			}
		});

		test('Premium cppcheck gets --premium=safety-off', async () => {
			const file = writeWorkFile('main.cpp');
			setReport([]);
			process.env.FAKE_CPPCHECK_VERSION = 'Cppcheck Premium 25.8.0';
			try {
				await runUntilPremiumFlag(() => openAndAnalyze(file), true);
			} finally {
				delete process.env.FAKE_CPPCHECK_VERSION;
				// The flag is module state in the extension, make sure it does not leak into other tests
				await runUntilPremiumFlag(() => openAndAnalyze(file), false);
			}
		});
	});
});
