// "Start next queued job" from the phone against the real queue and a simulated P1S: the phone is
// shown the item Start next would send, signs that id, and only that item starts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startTestLab, type TestLab } from '../testing/harness';
import { startCloudSim, type CloudSim } from '../../../../tools/cloud-sim';
import { fakeSliced } from '../printer/sliced';
import type { Queue } from '../modules/queue/service';
import type { CloudLink } from './link';
import { controlMac, open, phoneKeys, type PhoneKeys } from './phone';
import type { PrinterSummaryV2 } from './remote';

let sim: CloudSim;
let t: TestLab;
let cloud: CloudLink;
let keys: PhoneKeys;
let deviceId: string;
let p1s: string;

async function until(check: () => unknown, what: string, ms = 8000) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error(`timed out waiting for ${what}`);
}

const queue = () => t.rt.module('queue') as Queue;
/** What the phone reads: the P1S's sealed status. */
function seen(): PrinterSummaryV2 | null {
	const entry = (sim.state().printers?.printers as { sealed: string }[] | null)?.[0];
	if (!entry) return null;
	return JSON.parse(
		open(keys, Buffer.from(entry.sealed, 'base64'), `printers|${deviceId}`).toString()
	) as PrinterSummaryV2;
}
function dispatch(queueItemId: string) {
	const c = {
		commandId: randomUUID(),
		printerId: p1s,
		action: 'dispatch' as const,
		at: Date.now(),
		queueItemId
	};
	return { ...c, mac: controlMac(keys, c) };
}
function job(title: string) {
	const { lab, printing } = t.rt;
	const profileId =
		lab.snapshot().profiles[0]?.id ?? lab.createProfile({ name: 'Alex', color: 'blue' });
	const jobId = lab.createJob({ projectId: lab.createProject({ profileId, title }) });
	printing.attach(
		jobId,
		fakeSliced({
			minutes: 1,
			grams: 5,
			printerModelId: 'C12',
			filaments: [{ type: 'PLA', color: '#000000', grams: 5 }]
		}),
		`${title}.gcode.3mf`
	);
	return jobId;
}

beforeAll(async () => {
	sim = await startCloudSim();
	t = await startTestLab({ fleet: ['C12'], modules: ['queue'], env: { CLOUD_URL: sim.url } });
	cloud = t.rt.cloud!;
	const started = await cloud.link();
	sim.link(started.pairing!.userCode);
	await until(() => cloud.status().state === 'online', 'online');
	deviceId = sim.state().devices[0].id;
	const { url } = cloud.phoneKey();
	keys = phoneKeys(Buffer.from(new URL(url).hash.replace('#k=', ''), 'base64url'));
	p1s = t.printer('C12').info.id;
	await until(() => t.rt.printers.get(p1s)?.snapshot?.gcodeState === 'IDLE', 'idle printer');
});
afterAll(async () => {
	await t?.stop();
	await sim?.close();
});

describe('Start next from the phone', () => {
	it('starts only the item the phone was shown, on a printer that waits for Start next', async () => {
		const q = queue();
		// This printer starts queued jobs only when someone presses Start next.
		q.printer(p1s, { autoDispatch: false, plateCleared: true });
		const first = job('Rocket');
		const second = job('Boat');
		const a = q.add({ jobId: first, printerId: p1s });
		q.add({ jobId: second, printerId: p1s });
		cloud.setRemote({ shareProgress: true, shareQueue: true, remoteControl: true });
		await until(() => seen()?.next === a.id, 'next item shown to the phone');
		// The queue view says it waits for Start next, which the old check took for "not next".
		expect(q.list().items.find((i) => i.id === a.id)?.waitingFor).not.toBeNull();

		const other = q.list().items.find((i) => i.jobId === second)!.id;
		expect(await sim.control(dispatch(other))).toMatchObject({
			ok: false,
			error: 'The queue changed. Have another look before starting.'
		});
		const dispatched = t.nextEvent('queue.dispatched', () => true);
		expect(await sim.control(dispatch(a.id))).toEqual({ ok: true });
		expect(await dispatched).toMatchObject({ jobId: first, printerId: p1s });
		expect(t.rt.lab.snapshot().activity[0].message).toMatch(/^Started the next queued print on /);
	}, 30_000);

	it('offers nothing to start until the finished print is cleared from the plate', async () => {
		const q = queue();
		const second = q.list().items.find((i) => i.status === 'waiting')!.id;
		await t.nextEvent('print.finished', (e) => e.printerId === p1s, 20_000);
		await until(() => q.list().printers[0].plateClearNeeded, 'plate to clear');
		await until(() => seen()?.state === 'finished' && seen()?.next === null, 'nothing to start');
		expect(await sim.control(dispatch(second))).toMatchObject({
			ok: false,
			error: expect.stringMatching(/clear the plate/)
		});
		q.printer(p1s, { plateCleared: true });
		await until(() => seen()?.next === second, 'next item after the plate was cleared');
	}, 40_000);
});
