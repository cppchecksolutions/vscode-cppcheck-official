import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { extractRelatedInformation } from '../helpers/diagnosticHelpers';
import { splitArgsAndResolvePaths } from '../util/path';
import { writeSuppressionToProjectFile } from '../util/files';

// These tests describe the *expected* behaviour for a number of suspected bugs found in a code review.
// Each test is expected to FAIL on the current code; a failing test means the suspected bug is real.
// If the developer decides the current behaviour is intended, the test can simply be deleted or adjusted.

suite('Related information', () => {
	let dir: string;
	let sourceFile: string;

	setup(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cppcheck-related-'));
		sourceFile = path.join(dir, 'a.cpp');
		fs.writeFileSync(sourceFile, 'int main() {\n    int x;\n return x/0;\n}\n');
	});

	teardown(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('Extraction of related information from locations array', async () => {
		// cppcheck --xml emits <location file=".." line="2" column="9" info=".."/>.
		// extension.ts reads `mainLoc.column`, but extractRelatedInformation reads `loc.col`,
		// so the column becomes Number(undefined) - 1 === NaN.
		const locations = [
			{ $: { info: 'Variable x', line: '2', column: '9', file: sourceFile } },
			{ $: { info: 'Additional info', line: '3', column: '5', file: sourceFile } },
		];
		const infos = await extractRelatedInformation(locations as any);
		// Only locations beyond the 0:th location are counted as related information
		assert.strictEqual(infos.length, 1);
		// 0-indexing vs 1-indexing -> line: 3 becomes 2
		assert.strictEqual(infos[0].location.range.start.line, 2);
		// 0-indexing vs 1-indexing -> column: 5 becomes 4
		assert.strictEqual(infos[0].location.range.start.character, 4);
	});
});

suite('Argument parsing', () => {
	test('Parsing paths with blank spaces correctly', () => {
		// splitArgsAndResolvePaths does args.split(" "), so a quoted path with spaces is cut into pieces.
		const result = splitArgsAndResolvePaths('--project="/tmp/my dir/compile_commands.json" --enable=all');
		assert.deepStrictEqual(result, [
			'--project=/tmp/my dir/compile_commands.json',
			'--enable=all',
		]);
	});
});

suite('Suspected bugs: writeSuppressionToProjectFile', () => {
	let dir: string;

	function writeProject(content: string): vscode.Uri {
		const file = path.join(dir, 'test.cppcheck');
		fs.writeFileSync(file, content);
		return vscode.Uri.file(file);
	}

	setup(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cppcheck-project-'));
	});

	teardown(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('XML special characters in file name are escaped', async () => {
		// file/symbolName/warningType are interpolated straight into XML attributes.
		// A '&' or '"' in a path produces an invalid project file.
		const uri = writeProject('<?xml version="1.0"?>\n<project>\n    <paths/>\n</project>\n');
		await writeSuppressionToProjectFile(uri, 'nullPointer', 'src/a&b "c".cpp');
		const text = fs.readFileSync(uri.fsPath, 'utf8');
		assert.ok(text.includes('file="src/a&amp;b &quot;c&quot;.cpp"'), text);
	});

	test('Writing to broken project file returns false', async () => {
		// text.indexOf("</project>") is -1, positionAt(-1) is position 0 and lineAt(line - 1) is lineAt(-1) -> RangeError.
		// Better to return false so the caller can show "Failed to add suppression".
		const uri = writeProject('not a project file');
		const success = await writeSuppressionToProjectFile(uri, 'nullPointer');
		assert.strictEqual(success, false);
	});

	test('Self closing <suppressions/> are handled', async () => {
		const uri = writeProject('<?xml version="1.0"?>\n<project>\n    <suppressions/>\n</project>\n');
		await writeSuppressionToProjectFile(uri, 'nullPointer');
		const text = fs.readFileSync(uri.fsPath, 'utf8');
		const blocks = text.match(/<suppressions\b/g) ?? [];
		assert.strictEqual(blocks.length, 1, text);
	});
});