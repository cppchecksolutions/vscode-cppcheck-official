import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { findWorkspaceRoot, looksLikePath, resolvePath } from '../util/path';

suite('Path helpers', () => {
	suite('looksLikePath', () => {
		test('Strings with a forward slash', () => {
			assert.strictEqual(looksLikePath('src/main.cpp'), true);
			assert.strictEqual(looksLikePath('/usr/include'), true);
			assert.strictEqual(looksLikePath('build/'), true);
			assert.strictEqual(looksLikePath('~/project'), true);
		});

		test('Strings with a backslash', () => {
			assert.strictEqual(looksLikePath('src\\main.cpp'), true);
			assert.strictEqual(looksLikePath('C:\\project'), true);
		});

		test('Strings starting with a dot', () => {
			assert.strictEqual(looksLikePath('.'), true);
			assert.strictEqual(looksLikePath('..'), true);
			assert.strictEqual(looksLikePath('./build'), true);
			assert.strictEqual(looksLikePath('.hidden'), true);
		});

		test('File names with an extension', () => {
			assert.strictEqual(looksLikePath('main.cpp'), true);
			assert.strictEqual(looksLikePath('compile_commands.json'), true);
			assert.strictEqual(looksLikePath('archive.tar.gz'), true);
		});

		test('Plain option values are not paths', () => {
			for (const arg of ['all', 'style', 'c++17', 'unusedFunction', 'exhaustive', 'unix64', '4', '']) {
				assert.strictEqual(looksLikePath(arg), false, `"${arg}" should not look like a path`);
			}
		});

		test('Whole option flags are not paths', () => {
			for (const arg of ['--enable=all', '--inline-suppr', '--std=c++17', '-j4', '-DFOO', '--max-configs=12']) {
				assert.strictEqual(looksLikePath(arg), false, `"${arg}" should not look like a path`);
			}
		});

		test('Dots inside a value count as a file extension (pins current behavior)', () => {
			// These are false positives if the function is applied to values such as defines, versions and regexes.
			// Whether that matters depends on how the caller uses it.
			assert.strictEqual(looksLikePath('-DVERSION=1.2'), true);
			assert.strictEqual(looksLikePath('--rule=.+'), true);
		});

		test('A trailing dot is not an extension', () => {
			assert.strictEqual(looksLikePath('main.'), false);
		});
	});

	suite('findWorkspaceRoot', () => {
		test('Returns the first workspace folder, or the current directory when none is open', () => {
			const folders = vscode.workspace.workspaceFolders;
			const expected = folders && folders.length > 0 ? folders[0].uri.fsPath : process.cwd();
			assert.strictEqual(findWorkspaceRoot(), expected);
		});

		test('Result is a non-empty absolute path', () => {
			const root = findWorkspaceRoot();
			assert.ok(root.length > 0);
			assert.ok(path.isAbsolute(root));
		});
	});

	suite('resolvePath', () => {
		const root = () => findWorkspaceRoot();
		// Compares paths after normalization, so mixed separators on Windows do not matter
		const assertSamePath = (actual: string, expected: string) =>
			assert.strictEqual(path.normalize(actual), path.normalize(expected));

		test('Absolute paths are returned unchanged', () => {
			const absolute = path.join(os.tmpdir(), 'some', 'file.txt');
			assert.strictEqual(resolvePath(absolute), absolute);
		});

		test('${workspaceFolder} alone is the workspace root', () => {
			assertSamePath(resolvePath('${workspaceFolder}'), root());
		});

		test('${workspaceFolder} prefix is expanded', () => {
			assertSamePath(resolvePath('${workspaceFolder}/build/compile_commands.json'), path.join(root(), 'build', 'compile_commands.json'));
		});

		test('~ is expanded to the home directory', () => {
			assertSamePath(resolvePath('~'), os.homedir());
			assertSamePath(resolvePath('~/projects/app'), path.join(os.homedir(), 'projects', 'app'));
		});

		test('./ paths are resolved against the workspace root', () => {
			assertSamePath(resolvePath('./src/main.cpp'), path.join(root(), 'src', 'main.cpp'));
		});

		test('../ paths are resolved against the workspace root', () => {
			assertSamePath(resolvePath('../shared/lib.h'), path.resolve(root(), '..', 'shared', 'lib.h'));
		});

		test('Bare relative paths are treated as relative to the workspace root', () => {
			assertSamePath(resolvePath('src/main.cpp'), path.join(root(), 'src', 'main.cpp'));
			assertSamePath(resolvePath('compile_commands.json'), path.join(root(), 'compile_commands.json'));
		});

		test('. and .. alone are resolved against the workspace root', () => {
			assertSamePath(resolvePath('.'), root());
			assertSamePath(resolvePath('..'), path.resolve(root(), '..'));
		});

		test('Empty string resolves to the workspace root', () => {
			assertSamePath(resolvePath(''), root());
		});

		test('.. segments inside the path are normalized', () => {
			assertSamePath(resolvePath('src/../include/a.h'), path.join(root(), 'include', 'a.h'));
		});

		test('The result is always absolute', () => {
			for (const input of ['a', './a', '../a', '~/a', '${workspaceFolder}/a', '']) {
				assert.ok(path.isAbsolute(resolvePath(input)), `"${input}" did not resolve to an absolute path`);
			}
		});
	});
});