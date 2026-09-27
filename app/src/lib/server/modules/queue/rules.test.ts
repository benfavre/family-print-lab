import { describe, expect, it } from 'vitest';
import { decide, printerBlock, PLATE_MESSAGE, type ItemFacts, type PrinterFacts } from './rules';
import { defaultQueueSettings } from '$lib/shared/queue';
import type { LoadedSlot } from '$lib/shared/printing';

const PLA: LoadedSlot = {
	index: 0,
	label: 'A1',
	type: 'PLA',
	name: 'Bambu PLA Basic',
	color: '#2B2F36',
	remain: 80
};
const PETG: LoadedSlot = { ...PLA, index: 1, label: 'A2', type: 'PETG', name: 'PETG HF' };

const printer = (over: Partial<PrinterFacts> = {}): PrinterFacts => ({
	id: 'p1s',
	name: 'Garage P1S',
	model: 'C12',
	connected: true,
	reported: true,
	busy: false,
	developerModeOff: false,
	sending: false,
	slots: [PLA],
	autoDispatch: true,
	paused: false,
	plateClearNeeded: false,
	...over
});
const item = (over: Partial<ItemFacts> = {}, model: string | null = 'C12'): ItemFacts => ({
	id: 'i1',
	printerId: null,
	status: 'waiting',
	notBefore: null,
	requirePlateClear: true,
	reason: null,
	job: {
		status: 'Queued',
		sliced: {
			printerModelId: model,
			filaments: [{ id: 1, type: 'PLA', color: '#2B2F36', grams: 10, meters: 3 }]
		}
	},
	...over
});

const now = new Date(2026, 8, 28, 15, 0);
const noQuiet = defaultQueueSettings().quietHours;
const run = (printers: PrinterFacts[], items: ItemFacts[], extra = {}) =>
	decide(printers, items, { now, quiet: noQuiet, canWake: false, ...extra });

describe('which printer can take a queued job', () => {
	const off = { quiet: false, canWake: false, manual: false };
	it.each<[string, Partial<PrinterFacts>, Partial<typeof off>, string | null]>([
		['idle and connected', {}, {}, null],
		['paused queue', { paused: true }, {}, 'The queue is paused for this printer.'],
		[
			'auto start off',
			{ autoDispatch: false },
			{},
			'Starts queued jobs only when you press Start next.'
		],
		['auto start off, Start next pressed', { autoDispatch: false }, { manual: true }, null],
		['offline', { connected: false }, {}, 'The printer is not connected.'],
		['offline, a hook can wake it', { connected: false }, { canWake: true }, null],
		[
			'offline and never reported, a hook can wake it',
			{ connected: false, slots: null },
			{ canWake: true },
			'Waiting for the printer to report once.'
		],
		['no report yet', { reported: false }, {}, 'Waiting for the printer to report.'],
		['printing', { busy: true }, {}, 'Printing.'],
		['being sent a file', { sending: true }, {}, 'A print is being sent to it.'],
		['Developer Mode off', { developerModeOff: true }, {}, 'Needs Developer Mode on the printer.'],
		['quiet hours', {}, { quiet: true }, 'Quiet hours.'],
		['quiet hours, Start next pressed', {}, { quiet: true, manual: true }, null]
	])('%s', (_label, p, o, expected) => {
		expect(printerBlock(printer(p), { ...off, ...o })).toBe(expected);
	});
});

describe('the dispatcher', () => {
	it('starts the first item of a printer’s own column before “any printer” items', () => {
		const d = run(
			[printer()],
			[
				item({ id: 'any' }),
				item({ id: 'mine2', printerId: 'p1s' }),
				item({ id: 'mine1', printerId: 'p1s' })
			]
		);
		// Items arrive in position order; mine2 comes first in this list.
		expect(d.dispatch).toEqual([
			{ itemId: 'mine2', printerId: 'p1s', useAms: true, amsMapping: [0] }
		]);
		expect(d.waiting.mine1).toBeNull();
	});

	it('gives “any printer” items to the first free printer the file fits', () => {
		const x2d = printer({ id: 'x2d', name: 'X2D', model: 'N6' });
		const d = run(
			[x2d, printer()],
			[item({ id: 'p1s-file' }), item({ id: 'x2d-file' }, 'N6'), item({ id: 'any-file' }, null)]
		);
		expect(d.dispatch.map((x) => [x.itemId, x.printerId])).toEqual([
			['x2d-file', 'x2d'],
			['p1s-file', 'p1s']
		]);
		expect(d.waiting['any-file']).toBe('Waiting for a free printer.');
	});

	it('waits for the plate to be confirmed clear, unless the item does not ask for it', () => {
		const dirty = printer({ plateClearNeeded: true });
		const waiting = run([dirty], [item()]);
		expect(waiting.dispatch).toEqual([]);
		expect(waiting.blocked.p1s).toBe(PLATE_MESSAGE);
		expect(waiting.waiting.i1).toBe(`Garage P1S: ${PLATE_MESSAGE}`);
		expect(run([dirty], [item({ requirePlateClear: false })]).dispatch).toHaveLength(1);
	});

	it('does not start in quiet hours, except with Start next', () => {
		const quiet = noQuiet.map(() => ({ on: true, start: '14:00', end: '16:00' }));
		expect(run([printer()], [item()], { quiet }).dispatch).toEqual([]);
		expect(run([printer()], [item()], { quiet, manual: 'p1s' }).dispatch).toHaveLength(1);
	});

	it('waits for a not-before time', () => {
		const later = new Date(2026, 8, 28, 18, 30).toISOString();
		const d = run([printer()], [item({ notBefore: later })]);
		expect(d.dispatch).toEqual([]);
		expect(d.waiting.i1).toBe('Starts after 18:30.');
		expect(
			run([printer()], [item({ notBefore: new Date(2026, 8, 28, 14).toISOString() })]).dispatch
		).toHaveLength(1);
	});

	it('holds a file sliced for another model, naming both', () => {
		const d = run([printer()], [item({ printerId: 'p1s' }, 'N6')]);
		expect(d.hold).toEqual([
			{ itemId: 'i1', reason: 'This file was sliced for the X2D. Garage P1S is a P1S.' }
		]);
		expect(run([printer()], [item({}, 'N1')]).hold[0].reason).toBe(
			'No printer here takes files sliced for the A1 mini.'
		);
	});

	it('holds an item whose filament is not loaded, and says so only once', () => {
		const petg = item({
			printerId: 'p1s',
			job: {
				status: 'Queued',
				sliced: {
					printerModelId: 'C12',
					filaments: [{ id: 1, type: 'PETG', color: '#ffffff', grams: 5, meters: 2 }]
				}
			}
		});
		const d = run([printer()], [petg]);
		expect(d.dispatch).toEqual([]);
		expect(d.hold).toEqual([{ itemId: 'i1', reason: 'Filament 1 (PETG) has no AMS slot.' }]);
		// Already held for that reason: no new hold.
		const again = run([printer()], [{ ...petg, status: 'held', reason: d.hold[0].reason }]);
		expect(again.hold).toEqual([]);
		// Loaded now: the automatic hold is looked at again and the item starts.
		const fixed = run(
			[printer({ slots: [PLA, PETG] })],
			[{ ...petg, status: 'held', reason: d.hold[0].reason }]
		);
		expect(fixed.dispatch).toEqual([
			{ itemId: 'i1', printerId: 'p1s', useAms: true, amsMapping: [1] }
		]);
	});

	it('passes an “any printer” item on to a printer with the right filament', () => {
		const other = printer({ id: 'p1s-b', name: 'Loft P1S', slots: [PETG] });
		const petg = item({
			job: {
				status: 'Queued',
				sliced: {
					printerModelId: 'C12',
					filaments: [{ id: 1, type: 'PETG', color: '#ffffff', grams: 5, meters: 2 }]
				}
			}
		});
		expect(run([printer(), other], [petg]).dispatch.map((x) => x.printerId)).toEqual(['p1s-b']);
		// Nobody has it: held, naming the printer that turned it down.
		const held = run([printer()], [petg]);
		expect(held.hold[0].reason).toBe('Garage P1S: Filament 1 (PETG) has no AMS slot.');
	});

	it('prints from the external spool when nothing is loaded', () => {
		expect(run([printer({ slots: [] })], [item()]).dispatch[0]).toMatchObject({
			useAms: false,
			amsMapping: []
		});
	});

	it('keeps holds the person chose, and drops items whose job moved on', () => {
		const d = run(
			[printer()],
			[
				item({ id: 'held', status: 'held', reason: null }),
				item({ id: 'sent-by-hand', job: { status: 'Printing', sliced: null } }),
				item({ id: 'still-printing', status: 'sent', job: { status: 'Printing', sliced: null } }),
				item({ id: 'done', status: 'sent', job: { status: 'Succeeded', sliced: null } }),
				item({ id: 'gone', job: null })
			]
		);
		expect(d.dispatch).toEqual([]);
		expect(d.waiting.held).toBe('On hold.');
		expect(d.drop).toEqual(['sent-by-hand', 'done', 'gone']);
	});

	it('holds a job without a sliced file', () => {
		expect(run([printer()], [item({ job: { status: 'Queued', sliced: null } })]).hold).toEqual([
			{ itemId: 'i1', reason: 'Attach a sliced file first.' }
		]);
	});
});

describe('dual-nozzle queue mapping', () => {
	const leftJob = () => {
		const queued = item({}, 'N6');
		queued.job!.sliced!.filaments[0].extruder = 1;
		return queued;
	};
	const rightOnly = printer({
		id: 'x2d-right',
		name: 'Right feeder',
		model: 'N6',
		slots: [{ ...PLA, nozzle: 0 }]
	});
	const leftOnly = printer({
		id: 'x2d-left',
		name: 'Left feeder',
		model: 'N6',
		slots: [{ ...PLA, nozzle: 1 }]
	});
	it('passes an any-printer job to the printer whose feeder reaches its nozzle', () => {
		const d = run([rightOnly, leftOnly], [leftJob()]);
		expect(d.dispatch).toEqual([
			{ itemId: 'i1', printerId: 'x2d-left', useAms: true, amsMapping: [0] }
		]);
		expect(d.hold).toEqual([]);
	});
	it('holds an assigned job until the feeder binding fits', () => {
		const queued = { ...leftJob(), printerId: rightOnly.id };
		const held = run([rightOnly], [queued]);
		expect(held.dispatch).toEqual([]);
		expect(held.hold).toHaveLength(1);
		expect(held.hold[0].reason).toContain('no AMS slot');
		const fixed = run(
			[{ ...leftOnly, id: rightOnly.id }],
			[{ ...queued, status: 'held', reason: held.hold[0].reason }]
		);
		expect(fixed.dispatch).toHaveLength(1);
	});
});
