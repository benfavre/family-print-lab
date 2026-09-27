// The notifier on its own: the centre keeps the newest 500, secrets stay write-only, channels get
// what they asked for (and switched-off ones nothing), offline waits, alerts are told once, desktop
// and pictures follow their rules.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../db';
import { moduleSettings } from '../../module-settings';
import { fakeServer } from './testing';
import { Notifier, type DesktopBridge } from './notifier';
import type { Lookups } from './messages';
import { KEEP } from './store';
import { applyInput, DEFAULT_SETTINGS, settingsView } from './settings';
import { storedSettings, type StoredSettings } from './validation';
import type { CameraService } from '../contracts';

const lookups: Lookups = {
	printerName: () => 'X2D',
	printerState: () => null,
	job: (id) => (id === 'kid-job' ? { title: 'Rocket', kid: 'Mia' } : null),
	jobIdForTask: () => null,
	project: () => null,
	profile: () => null,
	hms: () => ({ text: 'Fan is slow.', severity: 'serious' }),
	printError: () => 'Spaghetti.'
};

function setup(
	o: { desktop?: DesktopBridge; camera?: CameraService; settings?: Partial<StoredSettings> } = {}
) {
	const db = openDatabase(':memory:');
	const settings = moduleSettings(db, 'notifications', storedSettings, DEFAULT_SETTINGS);
	if (o.settings) settings.set({ ...DEFAULT_SETTINGS, ...o.settings });
	const live: { channel: string; data: unknown }[] = [];
	const log: string[] = [];
	const notifier = new Notifier({
		db,
		settings,
		live: { send: (channel, data) => live.push({ channel, data }) },
		lookups,
		desktop: () => o.desktop,
		camera: () => o.camera,
		log: (m) => log.push(m),
		offlineDelayMs: 110_000
	});
	return { db, settings, notifier, live, log };
}

const failed = {
	printerId: 'p1',
	printerName: 'X2D',
	jobId: null,
	task: 'rocket',
	printError: 0x0300800a,
	hms: []
};

let servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
	for (const s of servers) await s.close();
	servers = [];
	vi.useRealTimers();
});
beforeEach(() => {
	servers = [];
});

describe('the notification centre', () => {
	it('records told events, publishes the unread count and keeps the newest 500', () => {
		const { notifier, live } = setup();
		notifier.handle('print.failed', failed);
		expect(notifier.store.unread()).toBe(1);
		expect(live[0]).toMatchObject({
			channel: 'notifications:changed',
			data: { unread: 1, item: { title: 'rocket failed', level: 'error', printerId: null } }
		});
		for (let i = 0; i < KEEP + 20; i++)
			notifier.notify({ title: `n${i}`, body: '', level: 'info' });
		const items = notifier.store.list({ limit: 200 });
		expect(items[0].title).toBe(`n${KEEP + 19}`);
		expect(notifier.store.unread()).toBe(KEEP);
		expect(notifier.store.markRead([items[0].id])).toBe(1);
		expect(notifier.store.markRead('all')).toBe(KEEP - 1);
		expect(notifier.store.unread()).toBe(0);
	});

	it('leaves out events switched off for the centre, and links only to app paths', () => {
		const { notifier } = setup({ settings: { inApp: ['print.finished'] } });
		notifier.handle('print.failed', failed);
		expect(notifier.store.unread()).toBe(0);
		notifier.notify({ title: 'x', body: '', level: 'info', link: 'https://evil.example' });
		expect(notifier.store.unread()).toBe(0); // "other" is off too
		const { notifier: n2 } = setup();
		n2.notify({ title: 'x', body: '', level: 'info', link: 'https://evil.example' });
		n2.notify({ title: 'y', body: '', level: 'info', link: '/jobs' });
		n2.notify({ title: 'z', body: '', level: 'info', link: '//evil.example/x' });
		n2.notify({ title: 'w', body: '', level: 'info', link: '/\\evil.example' });
		expect(n2.store.list().map((i) => i.link)).toEqual([null, null, '/jobs', null]);
	});
});

describe('settings', () => {
	it('never send secrets back and keep them when the browser leaves them out', () => {
		const saved = applyInput(
			{
				inApp: ['print.failed'],
				channels: [
					{ id: 'n', kind: 'ntfy', topic: 'lab-123', token: 'tk_1', events: ['print.failed'] },
					{ id: 'd', kind: 'discord', url: 'https://discord.com/api/webhooks/1/x' }
				]
			},
			DEFAULT_SETTINGS
		);
		expect(saved.channels[0]).toMatchObject({ server: 'https://ntfy.sh', token: 'tk_1' });
		const view = settingsView(saved, { last: new Map(), desktopAvailable: false, modules: [] });
		expect(JSON.stringify(view)).not.toContain('tk_1');
		expect(JSON.stringify(view)).not.toContain('webhooks/1/x');
		expect(view.channels[0]).toMatchObject({ hasToken: true });
		expect(view.channels[1]).toMatchObject({ hasUrl: true });
		expect(view.present).not.toContain('queue.held');
		// Saved again as the browser has it: secrets kept; null removes one.
		const again = applyInput({ ...view, channels: view.channels }, saved);
		expect(again.channels[0]).toMatchObject({ token: 'tk_1' });
		expect(again.channels[1]).toMatchObject({ url: 'https://discord.com/api/webhooks/1/x' });
		const cleared = applyInput(
			{ ...view, channels: [{ ...view.channels[0], token: null }] },
			saved
		);
		expect(cleared.channels[0]).toMatchObject({ token: null });
	});

	it('keep a saved secret only while the channel points where it was entered for', () => {
		const saved = applyInput(
			{
				inApp: [],
				channels: [
					{ id: 'n', kind: 'ntfy', server: 'https://ntfy.example.com', topic: 't1', token: 'tk_1' },
					{
						id: 'm',
						kind: 'email',
						host: 'smtp.example.com',
						port: 587,
						security: 'starttls',
						user: 'me',
						password: 'pw',
						from: 'a@example.com',
						to: 'b@example.com'
					},
					{ id: 'w', kind: 'webhook', url: 'https://hooks.example.com/a', secret: 's3' }
				]
			},
			DEFAULT_SETTINGS
		);
		const view = settingsView(saved, { last: new Map(), desktopAvailable: false, modules: [] });
		const [n, m, w] = view.channels as unknown as Record<string, unknown>[];
		const apply = (channels: Record<string, unknown>[]) =>
			applyInput({ inApp: [], channels }, saved);
		// Same place (another topic, a trailing slash, another path on the same site): kept.
		expect(
			apply([{ ...n, server: 'https://NTFY.example.com/', topic: 't2' }, m, w]).channels[0]
		).toMatchObject({ token: 'tk_1', topic: 't2' });
		expect(apply([n, m, { ...w, url: 'https://hooks.example.com/b' }]).channels[2]).toMatchObject({
			secret: 's3'
		});
		// Elsewhere: the secret must be typed again, or removed.
		expect(() => apply([{ ...n, server: 'https://evil.example' }, m, w])).toThrow(/token again/);
		expect(() => apply([{ ...n, server: undefined }, m, w])).toThrow(/token again/);
		expect(() => apply([n, { ...m, host: 'smtp.evil.example' }, w])).toThrow(/password again/);
		expect(() => apply([n, m, { ...w, url: 'https://evil.example/a' }])).toThrow(/secret again/);
		expect(
			apply([{ ...n, server: 'https://evil.example', token: 'tk_2' }, m, w]).channels[0]
		).toMatchObject({ token: 'tk_2' });
		expect(
			apply([{ ...n, server: 'https://ntfy.sh', token: null }, m, w]).channels[0]
		).toMatchObject({ token: null });
	});

	it('keep only edited templates and refuse bad channels', () => {
		const saved = applyInput(
			{
				inApp: [],
				templates: {
					'print.finished': {
						title: '{{task}} is done',
						body: '{{printer}} finished printing {{job}}.'
					},
					'print.failed': { title: 'Oh no: {{task}}', body: '{{error}}' }
				},
				channels: []
			},
			DEFAULT_SETTINGS
		);
		expect(Object.keys(saved.templates)).toEqual(['print.failed']);
		expect(() =>
			applyInput({ inApp: [], channels: [{ id: 'x', kind: 'ntfy', topic: 'no/slash' }] }, saved)
		).toThrow(/letters, digits/);
		expect(() =>
			applyInput({ inApp: [], channels: [{ id: 't', kind: 'telegram', chatId: '1' }] }, saved)
		).toThrow(/bot token/);
		expect(() =>
			applyInput(
				{
					inApp: [],
					channels: [
						{ id: 'a', kind: 'desktop' },
						{ id: 'b', kind: 'desktop' }
					]
				},
				saved
			)
		).toThrow(/only one/);
	});
});

describe('channels', () => {
	it('send to the channels that want the event; switched-off ones send nothing', async () => {
		const on = await fakeServer();
		const off = await fakeServer();
		servers.push(on, off);
		const { notifier } = setup({
			settings: {
				channels: [
					{ ...webhook('on', on.url), events: ['print.failed'] },
					{ ...webhook('off', off.url), events: ['print.failed'], enabled: false },
					{ ...webhook('other', off.url), events: ['print.finished'] }
				]
			}
		});
		notifier.handle('print.failed', failed);
		await notifier.idle();
		expect(on.received).toHaveLength(1);
		expect(JSON.parse(on.received[0].body.toString())).toMatchObject({ event: 'print.failed' });
		expect(off.received).toHaveLength(0);
		expect(notifier.last.get('on')).toMatchObject({ ok: true, detail: 'Delivered.' });
	});

	it('remember a failed delivery for Settings and log it', async () => {
		const s = await fakeServer(() => ({ status: 500, body: 'down' }));
		servers.push(s);
		const { notifier, log } = setup({
			settings: { channels: [{ ...webhook('w', s.url), events: ['print.failed'] }] }
		});
		notifier.handle('print.failed', failed);
		await notifier.idle();
		expect(notifier.last.get('w')).toMatchObject({
			ok: false,
			detail: 'The server answered 500: down'
		});
		expect(log.join()).toMatch(/webhook channel “w” failed/);
	});

	it('tell an alert once in ten minutes', () => {
		const { notifier } = setup();
		const hms = {
			printerId: 'p1',
			printerName: 'X2D',
			hms: { attr: 0x03000300, code: 0x00020002 }
		};
		notifier.handle('hms.raised', hms);
		notifier.handle('hms.cleared', hms);
		notifier.handle('hms.raised', hms);
		expect(notifier.store.unread()).toBe(1);
	});

	it('tell a printer offline only when it stays away', () => {
		vi.useFakeTimers();
		const { notifier } = setup();
		const who = { printerId: 'p1', printerName: 'X2D' };
		notifier.handle('printer.offline', { ...who, error: 'No answer.' });
		vi.advanceTimersByTime(60_000);
		notifier.handle('printer.online', who);
		vi.advanceTimersByTime(120_000);
		expect(notifier.store.unread()).toBe(0);
		notifier.handle('printer.offline', { ...who, error: 'No answer.' });
		vi.advanceTimersByTime(110_000);
		expect(notifier.store.list()[0]).toMatchObject({
			title: 'X2D is offline',
			body: 'It has not answered for 2 minutes. No answer.'
		});
		notifier.stop();
	});

	it('show desktop notifications through the bridge, and quiet hours silence them', async () => {
		const shown: unknown[][] = [];
		const desktop = { notify: (...a: unknown[]) => void shown.push(a) };
		const channel = {
			id: 'desktop',
			kind: 'desktop' as const,
			name: '',
			enabled: true,
			events: ['print.failed'],
			quiet: { enabled: false, from: '22:00', to: '07:00' },
			snapshots: false,
			hmsSeverity: 'serious' as const
		};
		const { notifier } = setup({ desktop, settings: { channels: [channel] } });
		notifier.handle('print.failed', failed);
		await notifier.idle();
		expect(shown).toEqual([['rocket failed', 'X2D stopped: Spaghetti.', '/printers/p1']]);
		const always = { ...channel, quiet: { enabled: true, from: '00:00', to: '23:59' } };
		const quiet = setup({ desktop, settings: { channels: [always] } });
		quiet.notifier.handle('print.failed', failed);
		await quiet.notifier.idle();
		expect(shown).toHaveLength(1);
		expect(await setup().notifier.test(channel)).toMatchObject({ ok: false });
	});

	it('attach a camera picture when asked, never for a kid’s print unless allowed', async () => {
		const s = await fakeServer();
		servers.push(s);
		const camera: CameraService = {
			has: () => true,
			getSnapshot: async () => Buffer.from('jpeg!')
		};
		const ntfy = {
			id: 'n',
			kind: 'ntfy' as const,
			name: '',
			enabled: true,
			events: ['print.failed'],
			quiet: { enabled: false, from: '22:00', to: '07:00' },
			snapshots: true,
			hmsSeverity: 'serious' as const,
			server: s.url,
			topic: 'lab',
			token: null
		};
		const { notifier } = setup({ camera, settings: { channels: [ntfy] } });
		notifier.handle('print.failed', failed);
		notifier.handle('print.failed', { ...failed, jobId: 'kid-job' });
		await notifier.idle();
		expect(s.received.map((r) => r.method).sort()).toEqual(['POST', 'PUT']);
		expect(s.received.find((r) => r.method === 'PUT')!.body.toString()).toBe('jpeg!');
	});
});

function webhook(id: string, url: string) {
	return {
		id,
		kind: 'webhook' as const,
		name: id,
		enabled: true,
		events: [] as string[],
		quiet: { enabled: false, from: '22:00', to: '07:00' },
		snapshots: false,
		hmsSeverity: 'serious' as const,
		url,
		secret: null
	};
}
