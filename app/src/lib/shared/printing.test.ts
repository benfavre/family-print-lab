import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	autoMapping,
	loadedSlots,
	mappingNozzleProblems,
	mappingProblems,
	slotFitsNozzle,
	trayLabel
} from './printing';
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

describe('physical nozzle bindings', () => {
	const left = {
		id: 1,
		type: 'PLA',
		color: '#FFFFFF',
		grams: 1,
		meters: 0.1,
		extruder: 1 as const
	};
	const right = { ...left, id: 2, extruder: 2 as const };
	const slots = [
		{
			index: 0,
			label: 'A1',
			type: 'PLA',
			name: 'PLA',
			color: '#FFFFFF',
			remain: 80,
			nozzle: 0 as const
		},
		{
			index: 4,
			label: 'B1',
			type: 'PLA',
			name: 'PLA',
			color: '#000000',
			remain: 80,
			nozzle: 1 as const
		}
	];
	it('keeps reported AMS bindings and the fixed external spool sides', () => {
		const state = fixture('h2d-ext-spool');
		const loaded = loadedSlots(state);
		for (const unit of state.ams) {
			for (const tray of unit.trays.filter((t) => t.type)) {
				expect(loaded.find((s) => s.index === tray.global)?.nozzle).toBe(
					unit.nozzle === 0 || unit.nozzle === 1 ? unit.nozzle : null
				);
			}
		}
		expect(loaded.find((s) => s.index === 254)?.nozzle).toBe(1);
		expect(loaded.find((s) => s.index === 255)?.nozzle).toBe(0);
	});
	it('keeps empty feeder bindings available to structural checks, but not to auto mapping', () => {
		const state = fixture('h2d-ext-spool');
		state.externalSpools.find((s) => s.global === 255)!.type = '';
		expect(loadedSlots(state).some((s) => s.index === 255)).toBe(false);
		expect(
			mappingNozzleProblems([left], [255], loadedSlots(state, { includeEmpty: true }))
		).toHaveLength(1);
	});
	it('checks the fixed external sides even when neither spool is reported', () => {
		const state = fixture('h2d-ext-spool');
		state.externalSpools = [];
		const all = loadedSlots(state, { includeEmpty: true });
		expect(mappingNozzleProblems([left, right], [255, 254], all)).toHaveLength(2);
		expect(mappingNozzleProblems([left, right], [254, 255], all)).toEqual([]);
	});
	it('does not interpret the sole extruder as a left nozzle on single-nozzle printers', () => {
		const state = fixture('h2d-ext-spool');
		state.nozzles = [state.nozzles[0]];
		const loaded = loadedSlots(state);
		expect(loaded.every((s) => s.nozzle === null)).toBe(true);
		const mapping = autoMapping([left], loaded);
		expect(mapping[0]).toBeGreaterThanOrEqual(0);
		expect(mappingNozzleProblems([left], mapping, loaded)).toEqual([]);
	});
	it('prefers a reachable nozzle over a closer colour and rejects a manual wrong-side choice', () => {
		expect(autoMapping([left, right], slots)).toEqual([4, 0]);
		expect(mappingNozzleProblems([left, right], [4, 0], slots)).toEqual([]);
		expect(mappingNozzleProblems([left], [0], slots)).toEqual([
			'Filament 1 uses the left nozzle, but slot A1 feeds the other nozzle.'
		]);
	});
	it('does not substitute the right external spool for a left-nozzle filament', () => {
		const external = { ...slots[0], index: 255, label: 'Ext R' };
		expect(autoMapping([left], [external])).toEqual([-1]);
		expect(mappingNozzleProblems([left], [255], [external])).toHaveLength(1);
	});
	it('preserves legacy files and unknown or switcher bindings without guessing a side', () => {
		expect(slotFitsNozzle({ ...left, extruder: undefined }, slots[0])).toBe(true);
		for (const nozzle of [null, undefined]) {
			const unknown = { ...slots[0], nozzle };
			expect(autoMapping([left], [unknown])).toEqual([0]);
			expect(mappingNozzleProblems([left], [0], [unknown])).toEqual([]);
		}
	});
});
