import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { autoMapping, loadedSlots, mappingProblems, trayLabel } from './printing';
import { mergeReport, parseReport, parseVersions } from '$lib/server/printer/report';
import { PRINTER_MODELS, type ModelCode } from './printers/models';

const fixture = (name: string) => {
	const f = JSON.parse(
		fs.readFileSync(
			path.join(import.meta.dirname, '../server/printer/__fixtures__/reports', `${name}.json`),
			'utf8'
		)
	);
	return parseReport(mergeReport({}, f.pushall), {
		model: PRINTER_MODELS[f.model as ModelCode],
		versions: parseVersions(f.get_version),
		accessCodeSet: true
	});
};

describe('loaded trays', () => {
	it('labels trays like the printer: A1–D4, HT1…, external spools', () => {
		expect(trayLabel(0)).toBe('A1');
		expect(trayLabel(7)).toBe('B4');
		expect(trayLabel(129)).toBe('HT2');
		expect(trayLabel(25)).toBe('A2');
		expect(trayLabel(255)).toBe('Ext');
		expect(trayLabel(255, true)).toBe('Ext R');
		expect(trayLabel(254, true)).toBe('Ext L');
	});

	it('lists AMS, AMS HT and external trays with global numbers', () => {
		const slots = loadedSlots(fixture('h2d-ext-spool'));
		expect(slots.map((s) => s.label)).toEqual([
			'A1',
			'A3',
			'A4',
			'B2',
			'B3',
			'B4',
			'C1',
			'C2',
			'C4',
			'D1',
			'D2',
			'D4',
			'HT1',
			'HT2',
			'Ext R',
			'Ext L'
		]);
		expect(slots.find((s) => s.label === 'HT2')?.index).toBe(129);
	});

	it('maps filaments to AMS trays first, an external spool only when it fits better', () => {
		const slots = loadedSlots(fixture('h2d-ext-spool'));
		const tpu = { id: 1, type: 'TPU', color: '#000000', grams: 5, meters: 1 };
		const pla = {
			id: 2,
			type: 'PLA',
			color: slots.find((s) => s.type === 'PLA')!.color!,
			grams: 5,
			meters: 1
		};
		const mapping = autoMapping([tpu, pla], slots);
		expect(mapping[0]).toBe(255);
		expect(mapping[1]).toBeLessThan(254);
		expect(mappingProblems([tpu, pla], mapping, slots)).toEqual([]);
		expect(mappingProblems([tpu], [-1], slots)[0]).toMatch(/no AMS slot/);
	});
});
