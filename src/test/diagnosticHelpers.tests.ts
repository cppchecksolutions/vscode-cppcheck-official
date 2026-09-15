import * as assert from 'assert';
import * as xml2js from 'xml2js';

import { extractRelatedInformation, setUpDiagnostic } from '../helpers/diagnosticHelpers';
import { multiLocationWarningXml, mulitpleLocationWarningUri } from './staticXml';
import * as vscode from 'vscode';

suite('diagnosticHelpers.ts Test Suite', () => {
	vscode.window.showInformationMessage('Starting diagnosticHelpers.ts tests');

	test('test setUpDiagnostic', () => {
		const line = 1;
		const colStart = 1;
		const colEnd = 3;
		const warningId = 'nullPointer';
		const warningMessage = 'Test warning: null Pointer';
		const severity = vscode.DiagnosticSeverity.Warning;
		const diagnostic = setUpDiagnostic(line, colStart, line, colEnd, warningId, warningMessage, severity);
		// Check that source is being set
		assert.strictEqual(diagnostic.source, "cppcheck");
		// Check that code is an object with link and Id on property 'target' for known warningId with documentation
		assert.strictEqual(typeof(diagnostic.code), "object");
		assert.strictEqual(typeof(diagnostic.code) === "object" ? diagnostic.code.value : '', warningId);
		// Check that code is a string with value of warningId in other cases
		const warningIdWithoutDocumentation = 'dummyWarningId';
		const diagnosticWithoutDocumentation = setUpDiagnostic(line, colStart, line, colEnd, warningIdWithoutDocumentation, warningMessage, severity);
		assert.strictEqual(diagnosticWithoutDocumentation.code, warningIdWithoutDocumentation);
	});

	test('test extractRelatedInformation', () => {
		const parser = new xml2js.Parser({ explicitArray: true });
		parser.parseString(multiLocationWarningXml, async (err, result) => {
			const errors = result?.results?.errors?.[0]?.error || [];
			const locations = errors[0].location;
			const relatedInfos = await extractRelatedInformation(locations);
			// Check that relatedInfos is populated
			assert.strictEqual(relatedInfos.length > 0, true);
			// Check that message is set
			assert.notEqual(relatedInfos[0].message, "");
			// Check that uri for location of warning is set 
			assert.strictEqual(relatedInfos[0].location.uri.toString, mulitpleLocationWarningUri);
		});
	});
});
