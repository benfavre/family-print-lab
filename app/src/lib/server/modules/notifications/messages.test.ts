// Templates and the event → message rules; routing (per-event toggles, alert severity, quiet hours,
// pictures).
import { describe, expect, it } from 'vitest';
import { buildMessage, hmsSeverity, hmsText, render, type Lookups, type Message } from './messages';
import { inQuietHours, severeEnough, wants, wantsPicture } from './routing';
import { storedChannel } from './validation';

const lookups: Lookups = {
	printerName: (id) => (id === 'p1' ? 'Garage X2D' : null),
	printerState: () => ({ task: 'rocket_v2', percent: 42.4 }),
	job: (id) =>
		id === 'kid-job'
			? { title: 'Pencil rocket', kid: 'Mia' }
			: id === 'j1'
				? { title: 'Cable dock', kid: null }
				: null,
	project: (id) => (id === 'pj' ? { title: 'Dragon', kid: 'Mia' } : null),
	profile: (id) => (id === 'kid' ? { name: 'Mia' } : null),
	hms: (code) =>
		code.attr === 0x07000200
			? { text: 'AMS A slot 1 is empty.', severity: 'common' }
			: { text: '', severity: 'unknown' },
	printError: (code) => (code === 0x0300800a ? 'Spaghetti detected.' : '')
};
const ref = {
	printerId: 'p1',
	printerName: 'Garage X2D',
	task: 'rocket_v2',
	at: '2026-09-27T10:00:00Z'
};
const build = (name: string, data: Record<string, unknown>, templates = {}) =>
	buildMessage({ name, data }, lookups, templates);

describe('templates', () => {
	it('fill placeholders and tidy what is left when a value is missing', () => {
		expect(render('{{task}} on {{ printer }} is done', { task: 'Rocket', printer: 'X2D' })).toBe(
			'Rocket on X2D is done'
		);
		expect(render('{{printer}}: {{error}} .', { printer: 'X2D' })).toBe('X2D:.');
		expect(render('Hello {{nope}} {{kid}}', { kid: 'Mia' })).toBe('Hello Mia');
	});
});

describe('event messages', () => {
	it('print finished: success, with the job title and a link to the printer', () => {
		const m = build('print.finished', { ...ref, jobId: 'j1', minutes: 40 })!;
		expect(m).toMatchObject({
			event: 'print.finished',
			level: 'success',
			title: 'rocket_v2 is done',
			body: 'Garage X2D finished printing Cable dock.',
			printerId: 'p1',
			jobId: 'j1',
			link: '/printers/p1',
			kidJob: false
		});
		expect(m.data).not.toHaveProperty('at');
	});

	it('print failed: the error in plain words, or its code when nobody knows it', () => {
		expect(
			build('print.failed', { ...ref, jobId: null, printError: 0x0300800a, hms: [] })!.body
		).toBe('Garage X2D stopped: Spaghetti detected.');
		expect(
			build('print.failed', {
				...ref,
				jobId: null,
				printError: 0,
				hms: [{ attr: 0x07000200, code: 0x00020001 }]
			})!.body
		).toBe('Garage X2D stopped: AMS A slot 1 is empty.');
	});

	it('a kid’s job: {{kid}} is the profile’s display name and pictures need a parent’s say-so', () => {
		const m = build(
			'print.finished',
			{ ...ref, jobId: 'kid-job' },
			{
				'print.finished': { title: '{{kid}}’s {{job}} is ready', body: '{{percent}}' }
			}
		)!;
		expect(m.title).toBe('Mia’s Pencil rocket is ready');
		expect(m.body).toBe('100 %');
		expect(m.kidJob).toBe(true);
	});

	it('print paused: says why; a runout pause is left to ams.runout', () => {
		expect(build('print.paused', { ...ref, jobId: null, reason: 'user', stage: 16 })).toMatchObject(
			{
				level: 'info',
				body: 'Garage X2D: Paused by the user'
			}
		);
		expect(build('print.paused', { ...ref, jobId: null, reason: 'filament', stage: 6 })).toBeNull();
		expect(
			build('ams.runout', { printerId: 'p1', printerName: 'Garage X2D', tray: 0 })
		).toMatchObject({
			title: 'Garage X2D ran out of filament',
			body: 'Load a new spool to carry on with rocket_v2.'
		});
	});

	it('printer alerts: severity from the hms package or the code, text or the code, deduplicated', () => {
		const known = build('hms.raised', { ...ref, hms: { attr: 0x07000200, code: 0x00020001 } })!;
		expect(known).toMatchObject({
			hmsSeverity: 'common',
			level: 'warning',
			body: 'AMS A slot 1 is empty.',
			dedupe: 'hms:p1:0700_0200_0002_0001'
		});
		const fatal = build('hms.raised', { ...ref, hms: { attr: 0x03000100, code: 0x00010001 } })!;
		expect(fatal).toMatchObject({ hmsSeverity: 'fatal', level: 'error' });
		expect(fatal.body).toBe('Alert 0300_0100_0001_0001');
		expect(hmsSeverity({ attr: 0, code: 0x00040001 })).toBe('info');
		expect(hmsSeverity({ attr: 0, code: 0x00090001 })).toBe('unknown');
		expect(hmsText({ attr: 0x0c000300, code: 0x00030008 })).toBe('0C00_0300_0003_0008');
	});

	it('a kid asking to print links to Family, with the display name and project', () => {
		expect(
			build('request.created', { requestId: 'r', profileId: 'kid', projectId: 'pj' })
		).toMatchObject({
			title: 'Mia asked to print',
			body: 'Mia would like to print Dragon.',
			link: '/family#requests',
			kidJob: true,
			printerId: null
		});
	});

	it('events from packages use their common fields; unknown events are not told', () => {
		expect(
			build('queue.held', { printerId: 'p1', jobId: 'j1', reason: 'Plate not cleared' })
		).toMatchObject({ body: 'Cable dock on Garage X2D: Plate not cleared' });
		expect(
			build('maintenance.due', { printerId: 'p1', label: 'Lubricate the rods' })
		).toMatchObject({ title: 'Garage X2D: maintenance due' });
		expect(build('print.layer', { ...ref, layer: 3 })).toBeNull();
		expect(build('spool.low', { printerId: 'p1' })).toBeNull();
	});
});

const message = (over: Partial<Message> = {}): Message => ({
	...build('print.failed', { ...ref, jobId: null, printError: 0x0300800a, hms: [] })!,
	...over
});
const channel = (over: Record<string, unknown> = {}) =>
	storedChannel.parse({
		id: 'c',
		kind: 'webhook',
		url: 'http://127.0.0.1/hook',
		events: ['print.failed', 'hms.raised', 'other'],
		...over
	});
const at = (hhmm: string) => new Date(`2026-09-27T${hhmm}:00`);

describe('routing', () => {
	it('quiet hours in local time, across midnight too', () => {
		const night = { enabled: true, from: '22:00', to: '07:00' };
		expect(inQuietHours(night, at('23:30'))).toBe(true);
		expect(inQuietHours(night, at('06:59'))).toBe(true);
		expect(inQuietHours(night, at('07:00'))).toBe(false);
		expect(inQuietHours(night, at('12:00'))).toBe(false);
		const nap = { enabled: true, from: '13:00', to: '15:00' };
		expect(inQuietHours(nap, at('14:00'))).toBe(true);
		expect(inQuietHours(nap, at('15:00'))).toBe(false);
		expect(inQuietHours({ ...night, enabled: false }, at('23:30'))).toBe(false);
	});

	it('per-event toggles, switched-off channels and quiet hours', () => {
		expect(wants(channel(), message(), at('12:00'))).toBe(true);
		expect(wants(channel({ enabled: false }), message(), at('12:00'))).toBe(false);
		expect(wants(channel({ events: ['print.finished'] }), message(), at('12:00'))).toBe(false);
		expect(
			wants(
				channel({ quiet: { enabled: true, from: '11:00', to: '13:00' } }),
				message(),
				at('12:00')
			)
		).toBe(false);
		// Anything outside the catalogue counts as "other".
		expect(wants(channel(), message({ event: 'kid.badge' }), at('12:00'))).toBe(true);
	});

	it('alerts below the channel’s severity stay in the app', () => {
		const alert = (s: Message['hmsSeverity']) => message({ event: 'hms.raised', hmsSeverity: s });
		expect(wants(channel({ hmsSeverity: 'serious' }), alert('fatal'), at('12:00'))).toBe(true);
		expect(wants(channel({ hmsSeverity: 'serious' }), alert('common'), at('12:00'))).toBe(false);
		expect(severeEnough('unknown', 'common')).toBe(true);
		expect(severeEnough('info', 'common')).toBe(false);
	});

	it('pictures only where the channel supports and wants them, and kids’ prints only when allowed', () => {
		const ntfy = channel({ kind: 'ntfy', server: 'https://ntfy.sh', topic: 't', snapshots: true });
		expect(wantsPicture(ntfy, message(), false)).toBe(true);
		expect(wantsPicture({ ...ntfy, snapshots: false }, message(), false)).toBe(false);
		expect(wantsPicture(channel({ snapshots: true }), message(), false)).toBe(false); // webhook
		expect(wantsPicture(ntfy, message({ kidJob: true }), false)).toBe(false);
		expect(wantsPicture(ntfy, message({ kidJob: true }), true)).toBe(true);
		expect(wantsPicture(ntfy, message({ printerId: null }), true)).toBe(false);
	});
});
