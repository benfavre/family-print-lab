import { describe, expect, it } from 'vitest';
import {
	codeFromKey,
	displayCode,
	hmsKeyOf,
	hmsModule,
	hmsSeverity,
	parseCodeInput,
	printErrorKey,
	printErrorModule,
	printErrorSeverity
} from './hms';

describe('HMS decoding', () => {
	it.each([
		[0x00010001, 'fatal'],
		[0x00020001, 'serious'],
		[0x00030007, 'common'],
		[0x0004000b, 'info'],
		[0x00050001, 'unknown'],
		[0, 'unknown'],
		[null, 'unknown']
	] as const)('severity of code %s is %s', (code, severity) => {
		expect(hmsSeverity(code)).toBe(severity);
	});

	it.each([
		[0x03002000, 'mc'],
		[0x05000400, 'mainboard'],
		[0x07002000, 'ams'],
		[0x08001000, 'toolhead'],
		[0x0c000300, 'xcam'],
		[0x12000000, 'unknown'],
		[0, 'unknown']
	] as const)('module of attr %s is %s', (attr, module) => {
		expect(hmsModule(attr)).toBe(module);
	});

	it('builds the 16-hex key from attr and code, like Bambu Studio get_long_error_code', () => {
		expect(hmsKeyOf({ attr: 0x07002000, code: 0x00020001 })).toBe('0700200000020001');
		expect(hmsKeyOf({ attr: 0x0c000300, code: 0x0003000b })).toBe('0C0003000003000B');
		// Values above 2^31 stay unsigned.
		expect(hmsKeyOf({ attr: 0xffffffff, code: null })).toBe('FFFFFFFF00000000');
		expect(displayCode('0700200000020001')).toBe('0700_2000_0002_0001');
	});

	it('keys, levels and modules of print errors', () => {
		expect(printErrorKey(0x07008011)).toBe('07008011');
		expect(displayCode(printErrorKey(0x0300400c))).toBe('0300_400C');
		expect(printErrorSeverity(0x0300400c)).toBe('serious');
		expect(printErrorSeverity(0x07008011)).toBe('common');
		expect(printErrorSeverity(0x1000c001)).toBe('info');
		expect(printErrorSeverity(0x03000001)).toBe('unknown');
		expect(printErrorModule(0x07008011)).toBe('ams');
		expect(printErrorModule(0x0c00403d)).toBe('xcam');
	});

	it('reads codes the way people type them', () => {
		expect(parseCodeInput('0700_2000_0002_0001')).toEqual({ kind: 'hms', key: '0700200000020001' });
		expect(parseCodeInput(' 0700-8011 ')).toEqual({ kind: 'print_error', key: '07008011' });
		expect(parseCodeInput('0c00403d')).toEqual({ kind: 'print_error', key: '0C00403D' });
		expect(parseCodeInput('HMS 12')).toBeNull();
		expect(codeFromKey('0700200000020001')).toEqual({ attr: 0x07002000, code: 0x00020001 });
		expect(codeFromKey('07008011')).toBe(0x07008011);
	});
});
