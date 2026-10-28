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
        console.log('Cppcheck 2.99');
        process.exit(0);
    }
    process.on('exit', () => fs.appendFileSync(process.env.FAKE_CPPCHECK_LOG + '.done', 'done\\n'));
    fs.appendFileSync(process.env.FAKE_CPPCHECK_LOG, JSON.stringify(args) + '\\n');
    process.stderr.write(fs.readFileSync(process.env.FAKE_CPPCHECK_XML, 'utf8'));
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

	async function setSetting(key: string, value: string | undefined) {
		await vscode.workspace.getConfiguration('cppcheck-official').update(key, value, vscode.ConfigurationTarget.Global);
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
});
