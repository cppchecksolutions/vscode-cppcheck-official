import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { extractRelatedInformation } from '../helpers/diagnosticHelpers';
import { getPremiumCertLink } from '../util/documentation';
import { splitArgsAndResolvePaths } from '../util/path';
import { writeSuppressionToProjectFile } from '../util/files';

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
		const locations = [
			{ $: { info: 'Variable x', line: '2', column: '9', file: sourceFile } },
			{ $: { info: 'Additional info', line: '3', column: '5', file: sourceFile } },
		];
		const infos = await extractRelatedInformation(locations as any);
		// Only locations beyond the 0:th location are counted as related information
		assert.strictEqual(infos.length, 2);
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

	teardown(async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		try {
			fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		} catch (err) {
			// A leftover temp directory says nothing about the code under test
			console.warn(`Could not remove ${dir}:`, err);
		}
	});

	test('XML special characters in file name are escaped', async () => {
		const uri = writeProject('<?xml version="1.0"?>\n<project>\n    <paths/>\n</project>\n');
		await writeSuppressionToProjectFile(uri, 'nullPointer', 'src/a&b "c".cpp');
		const text = fs.readFileSync(uri.fsPath, 'utf8');
		assert.ok(text.includes('file="src/a&amp;b &quot;c&quot;.cpp"'), text);
	});

	test('Writing to broken project file returns false', async () => {
		const uri = writeProject('not a project file');
		const success = await writeSuppressionToProjectFile(uri, 'nullPointer');
		assert.strictEqual(success, false);
	});
});

suite('getPremiumCertLink', () => {
	const baseUrl = 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/';

	test('Builds the link for a typical rule', () => {
		assert.strictEqual(
			getPremiumCertLink('premium-cert-arr37-c'),
			`${baseUrl}arrays-arr/arr37-c`
		);
	});

	// One case per entry in the category map, so a typo in any slug is caught
	const categories: Array<[prefix: string, slug: string]> = [
		['arr', 'arrays-arr'],
		['str', 'characters-and-strings-str'],
		['con', 'concurrency-con'],
		['dcl', 'declarations-and-initialization-dcl'],
		['env', 'environment-env'],
		['err', 'error-handling-err'],
		['exp', 'expressions-exp'],
		['flp', 'floating-point-flp'],
		['fio', 'input-output-fio'],
		['int', 'integers-int'],
		['mem', 'memory-management-mem'],
		['win', 'microsoft-windows-win'],
		['msc', 'miscellaneous-msc'],
		['pos', 'posix-pos'],
		['pre', 'preprocessor-pre'],
		['sig', 'signals-sig'],
	];

	for (const [prefix, slug] of categories) {
		test(`Category ${prefix} maps to ${slug}`, () => {
			const rule = `${prefix}30-c`;
			assert.strictEqual(getPremiumCertLink(`premium-cert-${rule}`), `${baseUrl}${slug}/${rule}`);
		});
	}

	test('Returns an empty string for codes that are not premium CERT codes', () => {
		assert.strictEqual(getPremiumCertLink('nullPointer'), '');
		assert.strictEqual(getPremiumCertLink('premium-misra-c-2012-1.1'), '');
		assert.strictEqual(getPremiumCertLink('arr37-c'), '');
		assert.strictEqual(getPremiumCertLink(''), '');
	});

	test('Returns an empty string for an unknown category', () => {
		assert.strictEqual(getPremiumCertLink('premium-cert-xyz12-c'), '');
	});

	test('Returns an empty string when nothing follows the prefix', () => {
		assert.strictEqual(getPremiumCertLink('premium-cert-'), '');
	});

	test('Returns an empty string when the rule is too short to contain a category', () => {
		assert.strictEqual(getPremiumCertLink('premium-cert-ar'), '');
	});

	test('Category matching is case sensitive', () => {
		// Pins current behavior: cppcheck uses lower case ids, so upper case is treated as unknown
		assert.strictEqual(getPremiumCertLink('premium-cert-ARR37-C'), '');
	});

	test('CERT C++ rules do not get a link', () => {
		// The links point at the CERT C standard, and the C++ categories (e.g. ctr, oop) are not in the map
		assert.strictEqual(getPremiumCertLink('premium-cert-ctr50-cpp'), '');
	});
});