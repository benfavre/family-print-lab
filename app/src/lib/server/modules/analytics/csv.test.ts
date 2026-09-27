import { describe, expect, it } from 'vitest';
import { csvField, exportCsv, toCsv } from './csv';

describe('CSV (RFC 4180)', () => {
	it('quotes fields with commas, quotes and line breaks, doubling quotes', () => {
		expect(csvField('plain')).toBe('plain');
		expect(csvField('a,b')).toBe('"a,b"');
		expect(csvField('say "hi"')).toBe('"say ""hi"""');
		expect(csvField('two\nlines')).toBe('"two\nlines"');
		expect(csvField('cr\rhere')).toBe('"cr\rhere"');
	});

	it('writes numbers as numbers and blanks for missing values', () => {
		expect(csvField(12.5)).toBe('12.5');
		expect(csvField(-3)).toBe('-3');
		expect(csvField(Number.NaN)).toBe('');
		expect(csvField(null)).toBe('');
		expect(csvField(undefined)).toBe('');
	});

	it('keeps spreadsheet formulas from running', () => {
		expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
		expect(csvField('+1')).toBe("'+1");
		expect(csvField('-2')).toBe("'-2");
		expect(csvField('@sum')).toBe("'@sum");
	});

	it('ends every line, the last included, with CRLF', () => {
		expect(toCsv(['a', 'b'], [[1, 'x,y']])).toBe('a,b\r\n1,"x,y"\r\n');
		expect(toCsv(['a'], [])).toBe('a\r\n');
	});

	it('lays out the export rows', () => {
		const csv = exportCsv([
			{
				jobId: 'j1',
				date: '2026-09-08 10:00',
				project: 'Dock, v2',
				person: 'Zoë',
				printer: 'Workshop',
				status: 'Failed',
				material: 'PLA',
				grams: 50,
				cost: 1,
				minutes: 30,
				reason: 'Spaghetti'
			}
		]).split('\r\n');
		expect(csv[0]).toBe(
			'Finished,Project,Person,Printer,Result,Material,Filament (g),Filament cost,Printer time (min),Failure reason,Job id'
		);
		expect(csv[1]).toBe('2026-09-08 10:00,"Dock, v2",Zoë,Workshop,Failed,PLA,50,1,30,Spaghetti,j1');
		expect(csv[2]).toBe('');
	});
});
