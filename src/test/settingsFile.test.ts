import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getArguments, getSettingsFilePath } from '../util/settingsFile';

suite('Settings file', () => {
	let workspaceRoot: string;
	let errorMessages: string[];
	const originalShowErrorMessage = vscode.window.showErrorMessage;

	// Fake VS Code configuration that returns the given value for the arguments setting
	const config = {
		get: (key: string, defaultValue?: unknown) =>
			key === 'cppcheck-official.arguments' ? '--from-vscode-settings' : defaultValue,
	} as vscode.WorkspaceConfiguration;

	function writeSettingsFile(content: string) {
		fs.writeFileSync(getSettingsFilePath(workspaceRoot), content);
	}

	setup(() => {
		workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cppcheck-settings-'));
		errorMessages = [];
		(vscode.window as { showErrorMessage: unknown }).showErrorMessage = (message: string) => {
			errorMessages.push(message);
			return Promise.resolve(undefined);
		};
		// Clear error memory from previous tests
		getArguments(config, workspaceRoot);
	});

	teardown(() => {
		(vscode.window as { showErrorMessage: unknown }).showErrorMessage = originalShowErrorMessage;
		fs.rmSync(workspaceRoot, { recursive: true, force: true });
	});

	test('Uses VS Code setting when there is no settings file', () => {
		assert.strictEqual(getArguments(config, workspaceRoot), '--from-vscode-settings');
		assert.deepStrictEqual(errorMessages, []);
	});

	test('Arguments as string', () => {
		writeSettingsFile('{"arguments": "--enable=style --project=build/compile_commands.json"}');
		assert.strictEqual(getArguments(config, workspaceRoot), '--enable=style --project=build/compile_commands.json');
		assert.deepStrictEqual(errorMessages, []);
	});

	test('Arguments as array', () => {
		writeSettingsFile('{"arguments": ["--enable=style", "--project=build/compile_commands.json"]}');
		assert.strictEqual(getArguments(config, workspaceRoot), '--enable=style --project=build/compile_commands.json');
		assert.deepStrictEqual(errorMessages, []);
	});

	test('Empty arguments in settings file override VS Code setting', () => {
		writeSettingsFile('{"arguments": ""}');
		assert.strictEqual(getArguments(config, workspaceRoot), '');
	});

	test('Uses VS Code setting when settings file has no arguments', () => {
		writeSettingsFile('{}');
		assert.strictEqual(getArguments(config, workspaceRoot), '--from-vscode-settings');
		assert.deepStrictEqual(errorMessages, []);
	});

	test('Changes to settings file are picked up', () => {
		writeSettingsFile('{"arguments": "--first"}');
		assert.strictEqual(getArguments(config, workspaceRoot), '--first');
		writeSettingsFile('{"arguments": "--second"}');
		assert.strictEqual(getArguments(config, workspaceRoot), '--second');
	});

	test('Invalid JSON reports error once and falls back to VS Code setting', () => {
		writeSettingsFile('{"arguments": ');
		assert.strictEqual(getArguments(config, workspaceRoot), '--from-vscode-settings');
		assert.strictEqual(getArguments(config, workspaceRoot), '--from-vscode-settings');
		assert.strictEqual(errorMessages.length, 1);
		assert.ok(errorMessages[0].includes('cppcheck.json'));
	});

	test('Invalid arguments type reports error', () => {
		writeSettingsFile('{"arguments": 5}');
		assert.strictEqual(getArguments(config, workspaceRoot), '--from-vscode-settings');
		assert.strictEqual(errorMessages.length, 1);
		assert.ok(errorMessages[0].includes('"arguments" must be a string or an array of strings'));
	});

	test('Settings file that is not an object reports error', () => {
		writeSettingsFile('["--enable=style"]');
		assert.strictEqual(getArguments(config, workspaceRoot), '--from-vscode-settings');
		assert.strictEqual(errorMessages.length, 1);
	});

	test('Error is reported again after settings file has been fixed and broken again', () => {
		writeSettingsFile('{"arguments": 5}');
		getArguments(config, workspaceRoot);
		writeSettingsFile('{"arguments": "--fixed"}');
		assert.strictEqual(getArguments(config, workspaceRoot), '--fixed');
		writeSettingsFile('{"arguments": 5}');
		getArguments(config, workspaceRoot);
		assert.strictEqual(errorMessages.length, 2);
	});
});
