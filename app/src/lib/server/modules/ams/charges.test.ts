import { describe, expect, it } from 'vitest';
import { planCharges, progressFraction } from './charges';

const f = (id: number, grams: number) => ({ id, type: 'PLA', color: '#fff', grams, meters: 1 });

describe('charging a print to the spools in its trays', () => {
	it('charges each linked tray the grams of the filaments it fed', () => {
		// Filament 1 → tray 2 (spool A), filament 3 → tray 5 (spool B), filament 2 unused on this plate.
		const plan = planCharges({
			filaments: [f(1, 12.34), f(3, 5)],
			dispatch: { useAms: true, amsMapping: [2, -1, 5] },
			links: new Map([
				[2, 'A'],
				[5, 'B']
			]),
			fraction: 1
		});
		expect(plan).toEqual([
			{ spoolId: 'A', tray: 2, grams: 12.3 },
			{ spoolId: 'B', tray: 5, grams: 5 }
		]);
	});

	it('scales a failed print by its progress and skips trays without a spool', () => {
		const plan = planCharges({
			filaments: [f(1, 10), f(2, 20)],
			dispatch: { useAms: true, amsMapping: [0, 1] },
			links: new Map([[1, 'B']]),
			fraction: 0.25
		});
		expect(plan).toEqual([{ spoolId: 'B', tray: 1, grams: 5 }]);
	});

	it('adds up filaments that share a tray', () => {
		const plan = planCharges({
			filaments: [f(1, 3), f(2, 4)],
			dispatch: { useAms: true, amsMapping: [128, 128] },
			links: new Map([[128, 'HT']]),
			fraction: 1
		});
		expect(plan).toEqual([{ spoolId: 'HT', tray: 128, grams: 7 }]);
	});

	it('feeds from the external spool when sent without the AMS on a single-nozzle printer', () => {
		expect(
			planCharges({
				filaments: [f(1, 9)],
				dispatch: { useAms: false, amsMapping: [] },
				links: new Map([[255, 'EXT']]),
				fraction: 1
			})
		).toEqual([{ spoolId: 'EXT', tray: 255, grams: 9 }]);
		// Dual-nozzle printers send the external spool per filament.
		expect(
			planCharges({
				filaments: [f(1, 9), f(2, 1)],
				dispatch: { useAms: false, amsMapping: [254, 255] },
				links: new Map([[254, 'L']]),
				fraction: 1
			})
		).toEqual([{ spoolId: 'L', tray: 254, grams: 9 }]);
	});

	it('reads how far a failed print got', () => {
		expect(progressFraction({ layer: 30, totalLayers: 120, percent: 50 })).toBe(0.25);
		expect(progressFraction({ percent: 40 })).toBe(0.4);
		expect(progressFraction({ percent: 140 })).toBe(1);
		expect(progressFraction({})).toBe(1);
	});
});
