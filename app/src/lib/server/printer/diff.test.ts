import { describe, expect, it } from 'vitest';
import { diffStatus } from './diff';
import {
	emptySnapshot,
	type PrinterSnapshot,
	type PrinterStatus,
	type PrinterTray
} from '$lib/shared/printers/status';

const printer = { id: 'p1', name: 'X2D' };
const status = (state: Partial<PrinterSnapshot> | null, connected = true): PrinterStatus => ({
	configured: true,
	connected,
	error: connected ? '' : 'gone',
	state: state ? emptySnapshot({ task: 'dock', ...state }) : null
});
const names = (prev: PrinterStatus | null, next: PrinterStatus) =>
	diffStatus(printer, prev, next, (t) => (t === 'dock' ? 'job-1' : null)).map((e) => e.name);
const tray = (global: number, over: Partial<PrinterTray> = {}): PrinterTray => ({
	slot: String(global % 4),
	active: false,
	type: 'PLA',
	name: '',
	color: '#ffffff',
	remain: 80,
	global,
	colors: [],
	infoIdx: '',
	idName: '',
	tagUid: null,
	trayUuid: null,
	weight: null,
	diameter: null,
	tempMin: null,
	tempMax: null,
	bedTemp: null,
	dryingTemp: null,
	dryingHours: null,
	k: null,
	state: null,
	totalLengthMm: null,
	isBambu: false,
	...over
});

describe('diffStatus', () => {
	const cases: [string, PrinterStatus | null, PrinterStatus, string[]][] = [
		['comes online', status(null, false), status(null), ['printer.online']],
		[
			'goes offline',
			status({ gcodeState: 'IDLE' }),
			status({ gcodeState: 'IDLE' }, false),
			['printer.offline']
		],
		[
			'starts (from idle)',
			status({ gcodeState: 'IDLE' }),
			status({ gcodeState: 'PREPARE' }),
			['print.started']
		],
		[
			'starts (first report while printing)',
			null,
			status({ gcodeState: 'RUNNING', layer: 3 }),
			['printer.online', 'print.started']
		],
		[
			'finishes',
			status({ gcodeState: 'RUNNING' }),
			status({ gcodeState: 'FINISH' }),
			['print.finished']
		],
		[
			'fails',
			status({ gcodeState: 'RUNNING' }),
			status({ gcodeState: 'FAILED', printError: 0x0300800a }),
			['print.failed']
		],
		[
			'cancelled (0300400C)',
			status({ gcodeState: 'RUNNING' }),
			status({ gcodeState: 'FAILED', printError: 0x0300400c }),
			['print.cancelled']
		],
		[
			'cancelled (0500400E)',
			status({ gcodeState: 'PAUSE' }),
			status({ gcodeState: 'FAILED', printError: 0x0500400e }),
			['print.cancelled']
		],
		[
			'stopped straight to idle',
			status({ gcodeState: 'RUNNING' }),
			status({ gcodeState: 'IDLE' }),
			['print.cancelled']
		],
		[
			'pauses and resumes',
			status({ gcodeState: 'PAUSE' }),
			status({ gcodeState: 'RUNNING' }),
			['print.resumed']
		],
		[
			'next layer',
			status({ gcodeState: 'RUNNING', layer: 4 }),
			status({ gcodeState: 'RUNNING', layer: 5 }),
			['print.layer']
		],
		[
			'nothing changed',
			status({ gcodeState: 'RUNNING', layer: 5 }),
			status({ gcodeState: 'RUNNING', layer: 5 }),
			[]
		],
		[
			'idle to finish (report after reconnect)',
			status({ gcodeState: 'IDLE' }),
			status({ gcodeState: 'FINISH' }),
			[]
		]
	];
	for (const [label, prev, next, expected] of cases)
		it(label, () => expect(names(prev, next)).toEqual(expected));

	it('names the pause reason from the stage, with a runout event for stage 6', () => {
		const run = status({ gcodeState: 'RUNNING', activeTray: 2 });
		const reason = (stage: number | null) => {
			const events = diffStatus(
				printer,
				run,
				status({
					gcodeState: 'PAUSE',
					stage: { id: stage, name: '', subStage: null, printStage: null }
				}),
				() => null
			);
			return events.map((e) =>
				e.name === 'print.paused' ? (e.data as { reason: string }).reason : e.name
			);
		};
		expect(reason(16)).toEqual(['user']);
		expect(reason(6)).toEqual(['filament', 'ams.runout']);
		expect(reason(35)).toEqual(['error']);
		expect(reason(null)).toEqual(['other']);
		const runout = diffStatus(
			printer,
			run,
			status({ gcodeState: 'PAUSE', stage: { id: 6, name: '', subStage: null, printStage: null } }),
			() => null
		)[1];
		expect(runout.data).toMatchObject({ tray: 2 });
	});

	it('carries the job and the task the print had', () => {
		const [finished] = diffStatus(
			printer,
			status({ gcodeState: 'RUNNING', task: 'dock' }),
			status({ gcodeState: 'FINISH', task: '' }),
			(t) => (t === 'dock' ? 'job-1' : null)
		);
		expect(finished.data).toMatchObject({
			printerId: 'p1',
			printerName: 'X2D',
			jobId: 'job-1',
			task: 'dock'
		});
	});

	it('raises and clears HMS alerts by attr and code', () => {
		const a = { attr: 1, code: 2 };
		const b = { attr: 3, code: 4 };
		const events = diffStatus(printer, status({ hms: [a] }), status({ hms: [b] }), () => null);
		expect(events.map((e) => [e.name, (e.data as { hms: unknown }).hms])).toEqual([
			['hms.raised', b],
			['hms.cleared', a]
		]);
	});

	it('notices tray changes that matter (type, colour, uuid, remain in 5 % steps)', () => {
		const unit = (trays: PrinterTray[]) => [
			{
				unit: '0',
				humidity: null,
				trays,
				id: 0,
				model: 'AMS' as const,
				humidityIndex: null,
				humidityPercent: null,
				temp: null,
				drying: null,
				serial: null,
				firmware: null,
				nozzle: null,
				dryStatus: null
			}
		];
		const before = status({ ams: unit([tray(0), tray(1)]) });
		expect(names(before, status({ ams: unit([tray(0, { remain: 79 }), tray(1)]) }))).toEqual([]);
		expect(names(before, status({ ams: unit([tray(0, { remain: 70 }), tray(1)]) }))).toEqual([
			'ams.tray.changed'
		]);
		const swapped = diffStatus(
			printer,
			before,
			status({ ams: unit([tray(0, { color: '#000000' })]) }),
			() => null
		);
		expect(swapped.map((e) => (e.data as { tray: number; after: unknown }).tray)).toEqual([0, 1]);
		expect((swapped[1].data as { after: unknown }).after).toBeNull();
	});
});
