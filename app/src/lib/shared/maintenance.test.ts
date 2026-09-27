import { describe, expect, it } from 'vitest';
import { accessoryRefusal, dueInfo, dueLabel, intervalLabel, nozzleTypeLabel } from './maintenance';

const day = 86_400_000;
const created = '2026-01-01T00:00:00.000Z';
const at = (days: number) => new Date(Date.parse(created) + days * day);
const task = (o: Partial<Parameters<typeof dueInfo>[0]> = {}) => ({
	intervalHours: null,
	intervalDays: null,
	lastDoneAt: null,
	lastDoneHours: 0,
	createdAt: created,
	...o
});

describe('when a maintenance task is due', () => {
	it('counts print hours since it was last done', () => {
		const t = task({ intervalHours: 100, lastDoneHours: 50 });
		expect(dueInfo(t, 50, at(0))).toMatchObject({ state: 'ok', by: 'hours', hoursLeft: 100 });
		expect(dueInfo(t, 136, at(0))).toMatchObject({ state: 'soon', hoursLeft: 14 });
		expect(dueInfo(t, 150, at(0))).toMatchObject({ state: 'due', hoursLeft: 0, progress: 1 });
		expect(dueInfo(t, 170, at(0))).toMatchObject({ state: 'due', hoursLeft: -20 });
	});

	it('counts days from the last time it was done, or from when it was added', () => {
		const t = task({ intervalDays: 30 });
		expect(dueInfo(t, 0, at(0))).toMatchObject({ state: 'ok', by: 'days', daysLeft: 30 });
		expect(dueInfo(t, 0, at(26))).toMatchObject({ state: 'soon', daysLeft: 4 });
		expect(dueInfo(t, 0, at(31))).toMatchObject({ state: 'due', daysLeft: -1 });
		const done = task({ intervalDays: 30, lastDoneAt: at(20).toISOString() });
		expect(dueInfo(done, 0, at(31))).toMatchObject({ state: 'ok', daysLeft: 19 });
	});

	it('lets the interval furthest along decide when there are both', () => {
		const t = task({ intervalDays: 30, intervalHours: 100 });
		expect(dueInfo(t, 10, at(29))).toMatchObject({ state: 'soon', by: 'days' });
		expect(dueInfo(t, 120, at(1))).toMatchObject({ state: 'due', by: 'hours' });
	});

	it('leaves tasks without an interval to the user', () => {
		expect(dueInfo(task(), 1000, at(900))).toEqual({
			state: 'manual',
			by: null,
			progress: null,
			hoursLeft: null,
			daysLeft: null
		});
	});

	it('never counts backwards when the odometer is lowered below the last-done mark', () => {
		expect(dueInfo(task({ intervalHours: 10, lastDoneHours: 50 }), 20, at(0))).toMatchObject({
			state: 'ok',
			hoursLeft: 10
		});
	});

	it('says it in plain words', () => {
		expect(dueLabel(dueInfo(task({ intervalDays: 30 }), 0, at(18)))).toBe('Due in 12 days');
		expect(dueLabel(dueInfo(task({ intervalHours: 10 }), 13, at(0)))).toBe('3 print hours overdue');
		expect(dueLabel(dueInfo(task({ intervalDays: 1 }), 0, at(0)))).toBe('Due in 1 day');
		expect(dueLabel(dueInfo(task(), 0, at(0)))).toBe('When needed');
		expect(intervalLabel({ intervalDays: 30, intervalHours: 200 })).toBe(
			'Every 30 days or 200 print hours'
		);
		expect(intervalLabel({ intervalDays: null, intervalHours: null })).toBe('When needed');
	});
});

describe('nozzle types', () => {
	it('reads old names and new type codes', () => {
		expect(nozzleTypeLabel('hardened_steel')).toBe('Hardened steel');
		expect(nozzleTypeLabel('stainless_steel')).toBe('Stainless steel');
		expect(nozzleTypeLabel('HS01')).toBe('Hardened steel, standard flow');
		expect(nozzleTypeLabel('HH01')).toBe('Hardened steel, high flow');
		expect(nozzleTypeLabel('HS00')).toBe('Stainless steel, standard flow');
		expect(nozzleTypeLabel('HS05')).toBe('Tungsten carbide, standard flow');
		expect(nozzleTypeLabel('N/A')).toBe('Unknown');
		expect(nozzleTypeLabel(null)).toBe('Unknown');
		expect(nozzleTypeLabel('ZZ99')).toBe('ZZ99');
	});
});

describe('which printers take system.set_accessories', () => {
	const one = { nozzles: 1, short: 'P1S' };
	it('single-nozzle printers that name the nozzle in the old report fields', () => {
		expect(accessoryRefusal(one, 'stainless_steel')).toBeNull();
		expect(accessoryRefusal(one, 'hardened_steel')).toBeNull();
		// Nothing reported yet: the command itself checks again when the report arrives.
		expect(accessoryRefusal(one, null)).toBeNull();
	});
	it('not printers that report device.nozzle.info type codes, nor dual-nozzle ones', () => {
		expect(accessoryRefusal({ nozzles: 1, short: 'P2S' }, 'HS01')).toMatch(/P2S reads its nozzles/);
		expect(accessoryRefusal({ nozzles: 2, short: 'H2D' }, 'stainless_steel')).toMatch(/H2D/);
	});
});
