import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getCompilationDatabasePath, isFileInCompilationDatabase } from '../util/files';
import { findWorkspaceRoot } from '../util/path';

suite('Compilation database', () => {
	let dir: string;

	// Same base directory the code under test uses to resolve relative "directory" entries
	const baseDir = () => findWorkspaceRoot() ?? process.cwd();

	function writeDb(entries: unknown, name = 'compile_commands.json') {
		const file = path.join(dir, name);
		fs.writeFileSync(file, typeof entries === 'string' ? entries : JSON.stringify(entries));
		return file;
	}

	function writeCppcheckProject(body: string, name = 'project.cppcheck') {
		const file = path.join(dir, name);
		fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>\n<project version="1">\n${body}\n</project>\n`);
		return file;
	}

	const xmlEscape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');

	setup(() => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cppcheck-db-')));
	});

	teardown(() => {
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	});

	suite('isFileInCompilationDatabase', () => {
		const source = () => path.join(dir, 'main.cpp');

		test('Finds a file listed with an absolute path', async () => {
			const db = writeDb([{ directory: dir, file: source(), command: 'c++ -c main.cpp' }]);
			assert.strictEqual(await isFileInCompilationDatabase(db, source()), true);
		});

		test('Finds a file listed relative to the entry directory', async () => {
			const db = writeDb([{ directory: dir, file: 'main.cpp', command: 'c++ -c main.cpp' }]);
			assert.strictEqual(await isFileInCompilationDatabase(db, source()), true);
		});

		test('Does not find a file that is not listed, such as a header', async () => {
			const db = writeDb([{ directory: dir, file: 'main.cpp', command: 'c++ -c main.cpp' }]);
			assert.strictEqual(await isFileInCompilationDatabase(db, path.join(dir, 'utils.h')), false);
		});

		test('An empty database lists no files', async () => {
			const db = writeDb([]);
			assert.strictEqual(await isFileInCompilationDatabase(db, source()), false);
		});

		test('Same file name in a different directory is not a match', async () => {
			const other = path.join(dir, 'other');
			const db = writeDb([{ directory: other, file: 'main.cpp', command: 'c++ -c main.cpp' }]);
			assert.strictEqual(await isFileInCompilationDatabase(db, source()), false);
			assert.strictEqual(await isFileInCompilationDatabase(db, path.join(other, 'main.cpp')), true);
		});

		test('Paths with .. segments are normalized', async () => {
			const db = writeDb([{ directory: dir, file: path.join('sub', '..', 'main.cpp'), command: 'c++ -c main.cpp' }]);
			assert.strictEqual(await isFileInCompilationDatabase(db, source()), true);
		});

		test('Relative directory is resolved against the workspace root, like cppcheck does', async () => {
			const db = writeDb([{ directory: path.relative(baseDir(), dir), file: 'main.cpp', command: 'c++ -c main.cpp' }]);
			assert.strictEqual(await isFileInCompilationDatabase(db, source()), true);
		});

		test('Directory "." resolves to the workspace root', async () => {
			const db = writeDb([{ directory: '.', file: path.relative(baseDir(), source()), command: 'c++ -c main.cpp' }]);
			assert.strictEqual(await isFileInCompilationDatabase(db, source()), true);
		});

		test('Entry without directory resolves the file against the workspace root', async () => {
			const db = writeDb([{ file: path.relative(baseDir(), source()), command: 'c++ -c main.cpp' }]);
			assert.strictEqual(await isFileInCompilationDatabase(db, source()), true);
		});

		test('Matches among many entries', async () => {
			const entries = Array.from({ length: 50 }, (_, i) => ({ directory: dir, file: `unit${i}.cpp`, command: 'c++' }));
			const db = writeDb(entries);
			assert.strictEqual(await isFileInCompilationDatabase(db, path.join(dir, 'unit49.cpp')), true);
			assert.strictEqual(await isFileInCompilationDatabase(db, path.join(dir, 'unit50.cpp')), false);
		});

		test('Case sensitivity follows the platform', async () => {
			const db = writeDb([{ directory: dir, file: 'main.cpp', command: 'c++ -c main.cpp' }]);
			const differentCase = path.join(dir, 'MAIN.cpp');
			// Windows file systems are case insensitive, the others are not
			assert.strictEqual(await isFileInCompilationDatabase(db, differentCase), process.platform === 'win32');
		});

		suite('falls back to "let cppcheck decide" (true) when the database cannot be used', () => {
			test('Missing database', async () => {
				assert.strictEqual(await isFileInCompilationDatabase(path.join(dir, 'missing.json'), source()), true);
			});

			test('Invalid JSON', async () => {
				const db = writeDb('[{"file": ');
				assert.strictEqual(await isFileInCompilationDatabase(db, source()), true);
			});

			test('Valid JSON that is not a list', async () => {
				const db = writeDb({ file: 'main.cpp' });
				assert.strictEqual(await isFileInCompilationDatabase(db, source()), true);
			});

			test('Database path is a directory', async () => {
				assert.strictEqual(await isFileInCompilationDatabase(dir, source()), true);
			});
		});
	});

	suite('getCompilationDatabasePath', () => {
		test('A .json project file is the database itself', async () => {
			const db = writeDb([]);
			assert.strictEqual(await getCompilationDatabasePath(db), db);
		});

		test('A .json project file is returned without checking that it exists', async () => {
			const missing = path.join(dir, 'missing.json');
			assert.strictEqual(await getCompilationDatabasePath(missing), missing);
		});

		test('Other project types are not handled', async () => {
			assert.strictEqual(await getCompilationDatabasePath(path.join(dir, 'solution.sln')), undefined);
			assert.strictEqual(await getCompilationDatabasePath(path.join(dir, 'project.vcxproj')), undefined);
		});

		suite('.cppcheck project files', () => {
			test('Relative importproject is resolved against the project file directory', async () => {
				const project = writeCppcheckProject('    <importproject>build/compile_commands.json</importproject>');
				assert.strictEqual(await getCompilationDatabasePath(project), path.resolve(dir, 'build', 'compile_commands.json'));
			});

			test('Project file in a subdirectory resolves relative to itself, not to the workspace', async () => {
				fs.mkdirSync(path.join(dir, 'config'));
				const project = writeCppcheckProject('    <importproject>../build/compile_commands.json</importproject>', path.join('config', 'project.cppcheck'));
				assert.strictEqual(await getCompilationDatabasePath(project), path.resolve(dir, 'build', 'compile_commands.json'));
			});

			test('Absolute importproject is used as is', async () => {
				const absolute = path.join(dir, 'elsewhere', 'compile_commands.json');
				const project = writeCppcheckProject(`    <importproject>${xmlEscape(absolute)}</importproject>`);
				assert.strictEqual(await getCompilationDatabasePath(project), path.normalize(absolute));
			});

			test('Backslashes in a relative path are accepted', async () => {
				const project = writeCppcheckProject('    <importproject>build\\compile_commands.json</importproject>');
				assert.strictEqual(await getCompilationDatabasePath(project), path.resolve(dir, 'build', 'compile_commands.json'));
			});

			test('Surrounding whitespace is ignored', async () => {
				const project = writeCppcheckProject('    <importproject>\n        build/compile_commands.json\n    </importproject>');
				assert.strictEqual(await getCompilationDatabasePath(project), path.resolve(dir, 'build', 'compile_commands.json'));
			});

			test('Works together with other elements', async () => {
				const project = writeCppcheckProject([
					'    <builddir>cppcheck-build</builddir>',
					'    <importproject>build/compile_commands.json</importproject>',
					'    <check-headers>true</check-headers>',
					'    <project-name>test</project-name>',
				].join('\n'));
				assert.strictEqual(await getCompilationDatabasePath(project), path.resolve(dir, 'build', 'compile_commands.json'));
			});

			test('No importproject element', async () => {
				const project = writeCppcheckProject('    <paths>\n        <dir name="."/>\n    </paths>');
				assert.strictEqual(await getCompilationDatabasePath(project), undefined);
			});

			test('Empty importproject element', async () => {
				const project = writeCppcheckProject('    <importproject/>');
				assert.strictEqual(await getCompilationDatabasePath(project), undefined);
			});

			test('Whitespace only importproject element', async () => {
				const project = writeCppcheckProject('    <importproject>   </importproject>');
				assert.strictEqual(await getCompilationDatabasePath(project), undefined);
			});

			test('importproject pointing to a Visual Studio solution or project', async () => {
				const sln = writeCppcheckProject('    <importproject>app.sln</importproject>', 'a.cppcheck');
				const vcxproj = writeCppcheckProject('    <importproject>app.vcxproj</importproject>', 'b.cppcheck');
				assert.strictEqual(await getCompilationDatabasePath(sln), undefined);
				assert.strictEqual(await getCompilationDatabasePath(vcxproj), undefined);
			});

			test('Malformed XML', async () => {
				const project = path.join(dir, 'broken.cppcheck');
				fs.writeFileSync(project, '<project><importproject>build/compile_commands.json');
				assert.strictEqual(await getCompilationDatabasePath(project), undefined);
			});

			test('Project file that does not exist', async () => {
				assert.strictEqual(await getCompilationDatabasePath(path.join(dir, 'missing.cppcheck')), undefined);
			});

			test('The imported database does not have to exist', async () => {
				// Existence is checked later, when the database is read
				const project = writeCppcheckProject('    <importproject>not-built-yet/compile_commands.json</importproject>');
				assert.strictEqual(await getCompilationDatabasePath(project), path.resolve(dir, 'not-built-yet', 'compile_commands.json'));
			});
		});
	});

	suite('Both together', () => {
		test('A header is not in the database that a .cppcheck project imports', async () => {
			const source = path.join(dir, 'main.cpp');
			writeDb([{ directory: dir, file: 'main.cpp', command: 'c++ -c main.cpp' }], 'compile_commands.json');
			const project = writeCppcheckProject('    <importproject>compile_commands.json</importproject>');

			const db = await getCompilationDatabasePath(project);
			assert.ok(db);
			assert.strictEqual(await isFileInCompilationDatabase(db, source), true);
			assert.strictEqual(await isFileInCompilationDatabase(db, path.join(dir, 'utils.h')), false);
		});
	});
});