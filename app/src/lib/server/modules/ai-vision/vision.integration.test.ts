// The AI check against a simulated A1 mini with its camera: a print runs, the simulated camera shows
// the part growing, then spaghetti (sim/features/vision.ts). The rough check (ffmpeg) and a stand-in AI
// provider both raise vision.alert, which becomes a notification and, when asked, pauses the print.
// Also the routes, the settings, kid mode and picture pruning.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { startTestLab, type TestLab } from '$lib/server/testing/harness';
import type { Provider, StructuredRequest } from '$lib/server/ai/providers';
import { kidAccess } from '$lib/server/kid/session';
import { setTrouble } from '$lib/server/printer/sim/features/vision';
import { VISION_SPAGHETTI } from '$lib/server/printer/sim/features/vision-fixtures';
import type { VisionCheck, VisionOverview, VisionSettingsView } from '$lib/shared/vision';
import { findFfmpeg } from '$lib/server/ffmpeg';
import { visionModule } from './module';
import { KEEP_FRAMES_MS } from './store';
import { GET as overviewRoute } from '../../../../routes/api/printers/[id]/vision/+server';
import { GET as checksRoute } from '../../../../routes/api/printers/[id]/vision/checks/+server';
import { POST as checkRoute } from '../../../../routes/api/printers/[id]/vision/check/+server';
import { PUT as printerRoute } from '../../../../routes/api/printers/[id]/vision/printer/+server';
import { GET as frameRoute } from '../../../../routes/api/printers/[id]/vision/frames/[checkId]/+server';
import {
	GET as getSettings,
	PUT as putSettings
} from '../../../../routes/api/vision/settings/+server';

const holder = globalThis as Record<symbol, unknown>;
const key = Symbol.for('family-print-lab.runtime');
const ffmpeg = findFfmpeg();
const ACTIVE = ['PREPARE', 'RUNNING', 'PAUSE'];
// Prints run in real time on the simulator (a layer a second).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 20_000 });

function event(params: Record<string, string>, pathname: string, init?: RequestInit) {
	const url = new URL(`http://localhost${pathname}`);
	return { params, url, request: new Request(url, init) } as unknown as RequestEvent;
}
const json = (body: unknown, method = 'PUT'): RequestInit => ({
	method,
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body)
});

async function until(ok: () => boolean, ms = 10_000) {
	const deadline = Date.now() + ms;
	while (!ok()) {
		if (Date.now() > deadline) throw new Error('Timed out.');
		await new Promise((r) => setTimeout(r, 25));
	}
}

async function lab(extra?: ReturnType<typeof visionModule>) {
	const t = await startTestLab({
		modules: ['camera', 'ai-vision', 'notifications'],
		env: ffmpeg ? { FFMPEG_PATH: ffmpeg } : {},
		extraModules: extra ? [extra] : undefined,
		fleet: ['N1']
	});
	holder[key] = t.rt;
	const id = t.printer('N1').info.id;
	await until(() => !!t.rt.module('camera')?.has(id));
	return { t, id };
}

/** Waits until the camera shows the spaghetti picture (the camera keeps a picture up to 1.5 s). */
async function spaghettiOnCamera(t: TestLab, id: string) {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const jpeg = await t.rt.module('camera')!.getSnapshot(id, { maxAgeMs: 200 });
		if (jpeg.toString('base64') === VISION_SPAGHETTI) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error('The camera never showed spaghetti.');
}

/** Starts a print and waits for the first two checks (the reference and one compared with it). */
async function printUntilChecked(t: TestLab, id: string) {
	const { sim } = t.printer('N1');
	sim.print.start({ name: 'rocket_v01', minutes: 40, layers: 40 });
	const vision = t.rt.module('ai-vision')!;
	await until(() => vision.store.list(id).length >= 2, 20_000);
	return sim;
}

describe.skipIf(!ffmpeg)('the rough check on a simulated print', () => {
	let t: TestLab;
	let id: string;

	beforeAll(async () => {
		({ t, id } = await lab());
	});
	afterAll(async () => {
		delete holder[key];
		await t?.stop();
	});

	it('is off by default and says how it would check', async () => {
		const res = await getSettings(event({}, '/api/vision/settings'));
		const view = (await res.json()) as VisionSettingsView;
		expect(view.settings).toMatchObject({ enabled: false, method: 'local', autoPause: false });
		expect(view.methods.map((m) => m.id)).toEqual([
			'local',
			'claude-code',
			'codex',
			'anthropic-api'
		]);
		expect(view).toMatchObject({ ffmpeg: true, camera: true });
		// The harness runs with LAB_AI=off, so no real provider counts as set up.
		expect(view.methods.map((m) => m.ready)).toEqual([true, false, false, false]);
	});

	it('flags spaghetti, notifies and pauses the print when asked', async () => {
		const put = await putSettings(
			event(
				{},
				'/api/vision/settings',
				json({ enabled: true, everyLayers: 2, everyMinutes: null, autoPause: true })
			)
		);
		expect(put.status).toBe(200);
		const sim = await printUntilChecked(t, id);
		const [second, first] = t.rt.module('ai-vision')!.store.list(id);
		expect(first).toMatchObject({
			verdict: 'ok',
			provider: 'local',
			task: 'rocket_v01',
			hasFrame: true
		});
		expect(first.reason).toMatch(/first picture/i);
		expect(second.verdict, second.reason).toBe('ok');

		const alert = t.nextEvent('vision.alert', (d) => d.printerId === id, 20_000);
		setTrouble(sim, 'spaghetti');
		const d = await alert;
		expect(d).toMatchObject({
			verdict: 'spaghetti',
			paused: true,
			provider: 'local',
			task: 'rocket_v01'
		});
		expect(d.confidence).toBeGreaterThanOrEqual(0.75);
		expect(d.reason).toMatch(/^Spaghetti \(\d+% sure, rough check\)\. .* The print is paused\.$/);
		await until(() => sim.state.gcode_state === 'PAUSE');
		await t.rt.module('ai-vision')!.idle();

		const stored = t.rt.module('ai-vision')!.store.get(d.checkId)!;
		expect(stored).toMatchObject({ alerted: true, paused: true, verdict: 'spaghetti' });
		// The notifications package turned the event into a message in the bell.
		await until(() =>
			t.rt
				.module('notifications')!
				.list()
				.items.some((n) => n.event === 'vision.alert')
		);
		const note = t.rt
			.module('notifications')!
			.list()
			.items.find((n) => n.event === 'vision.alert')!;
		expect(note.title).toContain('check the print');
		expect(note.body).toContain('Spaghetti');
		// Paused: no more automatic checks until it runs again.
		const count = t.rt.module('ai-vision')!.store.list(id).length;
		await new Promise((r) => setTimeout(r, 2500));
		expect(t.rt.module('ai-vision')!.store.list(id).length).toBe(count);
		// Checked again by hand while paused: it still sees spaghetti but does not alert again.
		await until(() => t.rt.printers.get(id)?.snapshot?.gcodeState === 'PAUSE');
		const again = await t.rt.module('ai-vision')!.checkNow(id);
		expect(again).toMatchObject({ verdict: 'spaghetti', alerted: false, paused: false });

		// Resumed by hand: the rough check takes what it sees now as normal and does not pause again.
		const store = t.rt.module('ai-vision')!.store;
		sim.print.resume();
		await until(() => !!store.list(id, { limit: 1 })[0]?.reason.includes('resumed after a pause'));
		const rebased = store.list(id).length;
		await until(() => store.list(id).length > rebased, 15_000);
		expect(store.list(id, { limit: 1 })[0]).toMatchObject({ verdict: 'ok', paused: false });
		expect(sim.state.gcode_state).toBe('RUNNING');
		sim.print.stop();
	});

	it('serves the history and the pictures', async () => {
		const res = await checksRoute(event({ id }, `/api/printers/${id}/vision/checks?limit=2`));
		const { checks } = (await res.json()) as { checks: VisionCheck[] };
		expect(checks).toHaveLength(2);
		expect(checks[0].at >= checks[1].at).toBe(true);
		const pic = await frameRoute(
			event({ id, checkId: checks[0].id }, `/api/printers/${id}/vision/frames/${checks[0].id}`)
		);
		expect(pic.headers.get('content-type')).toBe('image/jpeg');
		const bytes = Buffer.from(await pic.arrayBuffer());
		expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
		const missing = await frameRoute(
			event({ id, checkId: 'nope' }, `/api/printers/${id}/vision/frames/nope`)
		);
		expect(missing.status).toBe(404);
	});

	it('checks on demand, and says why between prints', async () => {
		// The app has heard that the print was stopped.
		await until(() => t.rt.printers.get(id)?.snapshot?.gcodeState === 'FAILED');
		const res = await checkRoute(
			event({ id }, `/api/printers/${id}/vision/check`, { method: 'POST' })
		);
		const { check } = (await res.json()) as { check: VisionCheck };
		expect(check).toMatchObject({ verdict: 'unsure', error: null, alerted: false });
		expect(check.reason).toMatch(/Nothing is printing/);
	});

	it('switches one printer off', async () => {
		const res = await printerRoute(
			event({ id }, `/api/printers/${id}/vision/printer`, json({ enabled: false }))
		);
		const { overview } = (await res.json()) as { overview: VisionOverview };
		expect(overview).toMatchObject({ active: false, printerOn: false, camera: true });
		const again = await overviewRoute(event({ id }, `/api/printers/${id}/vision`));
		expect(((await again.json()) as VisionOverview).recent.length).toBeGreaterThan(0);
	});

	it('removes pictures after 14 days and keeps the rows', async () => {
		const store = t.rt.module('ai-vision')!.store;
		const all = store.list(id, { limit: 200 });
		fs.writeFileSync(path.join(store.framesDir, 'stray.jpg'), 'x');
		const removed = store.prune(Date.now() + KEEP_FRAMES_MS + 60_000);
		expect(removed).toBe(all.filter((c) => c.hasFrame).length + 1);
		expect(store.list(id, { limit: 200 }).every((c) => !c.hasFrame)).toBe(true);
		expect(store.list(id, { limit: 200 })).toHaveLength(all.length);
		expect(fs.readdirSync(store.framesDir)).toEqual([]);
	});

	it('is grown-ups only in kid mode', () => {
		expect(kidAccess('PUT', '/api/vision/settings', null)).toBe('refuse');
		expect(kidAccess('POST', `/api/printers/${id}/vision/check`, null)).toBe('refuse');
		expect(kidAccess('GET', `/api/printers/${id}/vision`, null)).toBe('refuse');
	});
});

// The provider path needs no ffmpeg: the simulated camera already sends JPEGs.
describe('an AI provider on a simulated print', () => {
	let t: TestLab;
	let id: string;
	const asked: StructuredRequest[] = [];
	/** Set to hold the next answer until the test lets it go. */
	let hold: Promise<void> | null = null;
	const provider: Provider = {
		id: 'anthropic-api',
		status: async () => ({ id: 'anthropic-api', label: 'stand-in', available: true, detail: '' }),
		async structured<T>(req: StructuredRequest) {
			asked.push(req);
			if (hold) await hold;
			const spaghetti = req.image?.data === VISION_SPAGHETTI;
			return (
				spaghetti
					? { verdict: 'spaghetti', confidence: 0.93, reason: 'Loose strands all over the bed.' }
					: { verdict: 'ok', confidence: 0.9, reason: 'The part looks solid.' }
			) as T;
		},
		chat: async () => {}
	};

	beforeAll(async () => {
		({ t, id } = await lab(visionModule({ provider: () => provider })));
	});
	afterAll(async () => {
		delete holder[key];
		await t?.stop();
	});

	it('sends the picture with the print’s context and alerts on its answer', async () => {
		t.rt.module('ai-vision')!.saveSettings({
			enabled: true,
			method: 'anthropic-api',
			everyLayers: 2,
			everyMinutes: null
		});
		const sim = await printUntilChecked(t, id);
		expect(asked[0].image?.mediaType).toBe('image/jpeg');
		expect(asked[0].prompt).toContain('Printing: rocket_v01.');
		expect(asked[0].prompt).toMatch(/Layer \d+ of 40\./);
		expect(asked[0].prompt).toContain('Printer: Bambu Lab A1 mini.');
		expect(asked[0].schema).toMatchObject({ required: ['verdict', 'confidence', 'reason'] });

		const alert = t.nextEvent('vision.alert', (d) => d.printerId === id, 20_000);
		setTrouble(sim, 'spaghetti');
		const d = await alert;
		expect(d).toMatchObject({
			verdict: 'spaghetti',
			confidence: 0.93,
			paused: false,
			provider: 'anthropic-api',
			detail: 'Loose strands all over the bed.'
		});
		expect(d.reason).toBe('Spaghetti (93% sure). Loose strands all over the bed.');
		// Not paused (auto-pause is off): the print carries on.
		expect(sim.state.gcode_state).toBe('RUNNING');
		sim.print.stop();
		await t.rt.module('ai-vision')!.idle();
	});

	/** Starts a print and waits until the app sees it running (not the previous print's last report). */
	async function startPrint(task: string) {
		const { sim } = t.printer('N1');
		const snap = () => t.rt.printers.get(id)?.snapshot;
		await until(() => !ACTIVE.includes(snap()?.gcodeState ?? ''));
		sim.print.start({ name: task, minutes: 40, layers: 40 });
		await until(() => snap()?.task === task && snap()?.gcodeState === 'RUNNING');
		return { sim, snap };
	}

	it('pauses a print once: after a resume it carries on checking without pausing', async () => {
		const vision = t.rt.module('ai-vision')!;
		vision.saveSettings({
			method: 'anthropic-api',
			autoPause: true,
			everyLayers: null,
			everyMinutes: null
		});
		const { sim, snap } = await startPrint('dragon');
		setTrouble(sim, 'spaghetti');
		await spaghettiOnCamera(t, id);
		const first = await vision.checkNow(id);
		expect(first).toMatchObject({ verdict: 'spaghetti', alerted: true, paused: true });
		await until(() => snap()?.gcodeState === 'PAUSE');

		// Someone looked and resumed it: the same answer no longer pauses it (or alerts within 15 min).
		sim.print.resume();
		await until(() => snap()?.gcodeState === 'RUNNING');
		const again = await vision.checkNow(id);
		expect(again).toMatchObject({ verdict: 'spaghetti', alerted: false, paused: false });
		expect(sim.state.gcode_state).toBe('RUNNING');
		sim.print.stop();
		vision.saveSettings({ autoPause: false });
	});

	it('does not alert about a print that ended while the AI was answering', async () => {
		const vision = t.rt.module('ai-vision')!;
		const { sim, snap } = await startPrint('vase');
		setTrouble(sim, 'spaghetti');
		await spaghettiOnCamera(t, id);
		let release = () => {};
		hold = new Promise((r) => (release = r));
		const alerts: unknown[] = [];
		const off = t.rt.bus.on('vision.alert', (d) => alerts.push(d));
		const pending = vision.checkNow(id);
		await until(() => asked.length > 0 && vision.checker.isRunning(id));
		sim.print.stop();
		await until(() => !ACTIVE.includes(snap()?.gcodeState ?? ''));
		hold = null;
		release();
		const check = await pending;
		off();
		expect(check).toMatchObject({ verdict: 'spaghetti', alerted: false, paused: false });
		expect(alerts).toEqual([]);
	});

	it('lists only the problems when asked', async () => {
		const res = await checksRoute(event({ id }, `/api/printers/${id}/vision/checks?problems=1`));
		const { checks } = (await res.json()) as { checks: VisionCheck[] };
		expect(checks.length).toBeGreaterThan(0);
		expect(checks.every((c) => c.verdict !== 'ok')).toBe(true);
		const all = t.rt.module('ai-vision')!.list(id, {});
		expect(all.some((c) => c.verdict === 'ok')).toBe(true);
	});

	it('stores a provider failure as a check that could not run', async () => {
		const failing = visionModule({
			provider: () => ({
				...provider,
				structured: async () => {
					throw new Error('Rate limited by Anthropic. Wait a moment and try again.');
				}
			})
		});
		await t.stop();
		({ t, id } = await lab(failing));
		t.rt.module('ai-vision')!.saveSettings({ method: 'anthropic-api' });
		t.printer('N1').sim.print.start({ name: 'box', minutes: 40, layers: 40 });
		await until(() => t.printer('N1').sim.state.gcode_state === 'RUNNING');
		const check = await t.rt.module('ai-vision')!.checkNow(id);
		expect(check).toMatchObject({
			verdict: 'unsure',
			confidence: 0,
			alerted: false,
			hasFrame: true
		});
		expect(check.error).toMatch(/Rate limited/);
		t.printer('N1').sim.print.stop();
	});
});
