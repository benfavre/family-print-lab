import { describe, expect, it } from 'vitest';
import { MODEL_CODES, PRINTER_MODELS } from '$lib/shared/printers/models';
import { amsTasks, defaultTasksFor, RELEASE_NOTES, type DefaultTask } from './defaults';

const WIKI = /^https:\/\/wiki\.bambulab\.com\/en\/[\w/-]+$/;

function checkTask(t: DefaultTask) {
	// Every task, and so every interval, cites a wiki page and quotes it.
	expect(t.source, t.label).toMatch(WIKI);
	expect(t.quote.length, t.label).toBeGreaterThan(10);
	if (t.intervalDays !== null) expect(t.intervalDays).toBeGreaterThan(0);
	if (t.intervalHours !== null) expect(t.intervalHours).toBeGreaterThan(0);
}

describe('default maintenance tasks', () => {
	it('exist for every model, each with a wiki source and no duplicate kinds', () => {
		for (const code of MODEL_CODES) {
			const m = PRINTER_MODELS[code];
			const list = defaultTasksFor(m.code, m.series);
			expect(list.length, code).toBeGreaterThan(3);
			expect(new Set(list.map((t) => t.kind)).size, code).toBe(list.length);
			list.forEach(checkTask);
		}
	});

	it('quote the numbers they use', () => {
		const all = MODEL_CODES.flatMap((c) =>
			defaultTasksFor(PRINTER_MODELS[c].code, PRINTER_MODELS[c].series)
		);
		for (const t of all.filter((t) => t.intervalHours !== null))
			expect(t.quote.replace(',', ''), t.label).toContain(String(t.intervalHours));
		const words: Record<number, RegExp> = {
			7: /week/i,
			14: /two weeks/i,
			30: /month/i,
			60: /2 months|two months/i,
			90: /3 months|three months/i,
			120: /4 months/i,
			180: /6 months/i
		};
		for (const t of all.filter((t) => t.intervalDays !== null))
			expect(t.quote, t.label).toMatch(words[t.intervalDays!]);
	});

	it('leave "per roll" advice without an interval', () => {
		const x1c = defaultTasksFor('BL-P001', 'X1');
		expect(x1c.find((t) => t.kind === 'cutter')).toMatchObject({
			intervalDays: null,
			intervalHours: null
		});
		// The P1 page gives no carbon filter interval, so there is no made-up one.
		expect(defaultTasksFor('C12', 'P1').some((t) => t.kind === 'carbon_filter')).toBe(false);
	});

	it('add the desiccant check only for sealed AMS units', () => {
		expect(amsTasks([{ model: 'AMS' }]).map((t) => t.kind)).toEqual(['ams_desiccant', 'ams_ptfe']);
		expect(amsTasks([{ model: 'AMS Lite' }]).map((t) => t.kind)).toEqual(['ams_ptfe']);
		[...amsTasks([{ model: 'AMS' }]), ...amsTasks([{ model: 'AMS Lite' }])].forEach(checkTask);
	});

	it('link every model to its firmware release notes', () => {
		for (const code of MODEL_CODES) expect(RELEASE_NOTES[code], code).toMatch(WIKI);
	});
});
