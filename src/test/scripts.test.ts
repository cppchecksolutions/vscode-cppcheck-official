import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { processArguments } from '../helpers/settingsHelpers';
import { runCommand } from '../util/scripts';

suite('Script arguments', function () {
	this.timeout(20000);

	let dir: string;
	let errorMessages: string[];
	const originalShowErrorMessage = vscode.window.showErrorMessage;

	// Writes a node script and returns the shell command that runs it
	function scriptCommand(source: string) {
		const file = path.join(dir, 'script.js');
		fs.writeFileSync(file, source);
		return `node "${file}"`;
	}

	// Command whose stdout is exactly the given text
	function printing(text: string) {
		return scriptCommand(`process.stdout.write(${JSON.stringify(text)});`);
	}

	setup(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cppcheck-script-'));
		errorMessages = [];
		(vscode.window as { showErrorMessage: unknown }).showErrorMessage = (message: string) => {
			errorMessages.push(message);
			return Promise.resolve(undefined);
		};
	});

	teardown(() => {
		(vscode.window as { showErrorMessage: unknown }).showErrorMessage = originalShowErrorMessage;
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	});

	suite('processArguments', () => {
		test('Arguments without a script are returned unchanged', async () => {
			assert.strictEqual(await processArguments('--enable=all --inline-suppr'), '--enable=all --inline-suppr');
		});

		test('Script output replaces the script placeholder between other arguments', async () => {
			const command = printing('@(--std=c++17 -DFOO)\n');
			assert.strictEqual(
				await processArguments(`--enable=all @(${command}) --inline-suppr`),
				'--enable=all --std=c++17 -DFOO --inline-suppr'
			);
		});

		test('Script placeholder at the start and at the end', async () => {
			const command = printing('@(--std=c++17)');
			assert.strictEqual(await processArguments(`@(${command}) --inline-suppr`), '--std=c++17 --inline-suppr');
			assert.strictEqual(await processArguments(`--inline-suppr @(${command})`), '--inline-suppr --std=c++17');
		});

		test('Only the wrapped part of the script output is used', async () => {
			const command = printing('Generating arguments...\n@(--std=c++17)\nDone\n');
			assert.strictEqual(await processArguments(`--enable=all @(${command})`), '--enable=all --std=c++17');
		});

		test('Array syntax is converted to space separated arguments', async () => {
			const result = await processArguments('[--enable=all, --inline-suppr]');
			assert.deepStrictEqual(result.split(/\s+/).filter(Boolean), ['--enable=all', '--inline-suppr']);
		});

		test('Script output that is not wrapped in @() is rejected', async () => {
			// Currently this surfaces as a TypeError from the string splitting. A readable error message would be better
			const command = printing('--std=c++17');
			await assert.rejects(processArguments(`--enable=all @(${command})`));
		});

		test('Failing script is rejected', async () => {
			const command = scriptCommand('process.exit(3);');
			await assert.rejects(processArguments(`--enable=all @(${command})`));
		});
	});

	suite('runCommand', () => {
		test('Returns stdout', async () => {
			assert.strictEqual(await runCommand(printing('hello')), 'hello');
			assert.deepStrictEqual(errorMessages, []);
		});

		test('Reports stderr to the user but still returns stdout', async () => {
			const command = scriptCommand(`process.stderr.write('something went wrong'); process.stdout.write('output');`);
			assert.strictEqual(await runCommand(command), 'output');
			assert.strictEqual(errorMessages.length, 1);
			assert.ok(errorMessages[0].includes('something went wrong'));
		});

		test('Rejects when the command exits with an error', async () => {
			await assert.rejects(runCommand(scriptCommand('process.exit(1);')));
		});
	});
});