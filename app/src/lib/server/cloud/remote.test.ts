// Protocol v2 against the cloud simulator and a simulated fleet: every printer on the phone, signed
// pause/resume/stop, sealed status and camera pictures, and what the cloud can and cannot do.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startTestLab, type TestLab } from '../testing/harness';
import { startCloudSim, type CloudSim } from '../../../../tools/cloud-sim';
import type { CloudLink } from './link';
import { controlMac, open, openSnapshot, phoneKeys, type PhoneKeys } from './phone';
import type { PrinterSummaryV2 } from './remote';
import { isJpeg } from '../modules/camera/jpeg6000';

let sim: CloudSim;
let t: TestLab;
let cloud: CloudLink;
let keys: PhoneKeys;
let deviceId: string;

async function until(check: () => unknown, what: string, ms = 8000) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error(`timed out waiting for ${what}`);
}

const fleetPrinter = (model: string) => t.fleet.printers.find((p) => p.sim.model.code === model)!;
const printers = () => (sim.state().printers?.printers ?? null) as Record<string, unknown>[] | null;
/** What the phone does: build the command in the browser and sign it with the phone key. */
function command(printerId: string, action: 'pause' | 'resume' | 'stop', over = {}) {
	const c = { commandId: randomUUID(), printerId, action, at: Date.now(), ...over };
	return { ...c, mac: controlMac(keys, c) };
}

beforeAll(async () => {
	sim = await startCloudSim();
	t = await startTestLab({
		fleet: ['N6', 'C12'],
		modules: ['camera'],
		env: { CLOUD_URL: sim.url }
	});
	cloud = t.rt.cloud!;
	const started = await cloud.link();
	sim.link(started.pairing!.userCode);
	await until(() => cloud.status().state === 'online', 'online');
	deviceId = sim.state().devices[0].id;
	const { url } = cloud.phoneKey();
	keys = phoneKeys(Buffer.from(new URL(url).hash.replace('#k=', ''), 'base64url'));
});
afterAll(async () => {
	await t?.stop();
	await sim?.close();
});

describe('Print Lab Cloud protocol v2', () => {
	it('says hello with v2 and sends nothing about printers until status sharing is on', async () => {
		expect(sim.state().hello).toEqual({ app: expect.any(String), protocol: 2 });
		await until(() => sim.state().printers, 'printers message');
		expect(printers()).toBeNull();
		expect(sim.state().queue).toMatchObject({ items: null });
		expect(cloud.status()).toMatchObject({
			protocol: 2,
			shareProgress: false,
			remoteControl: false,
			phoneKey: { id: keys.id }
		});
	});

	it('shares every printer, sealed with the phone key, only id, state and event in clear', async () => {
		cloud.setRemote({ shareProgress: true });
		await until(() => printers()?.length === 2, 'two printers');
		const list = printers()!;
		for (const entry of list) {
			expect(Object.keys(entry).sort()).toEqual(['event', 'id', 'sealed', 'state']);
			const opened = JSON.parse(
				open(keys, Buffer.from(entry.sealed as string, 'base64'), `printers|${deviceId}`).toString()
			) as PrinterSummaryV2;
			expect(opened.id).toBe(entry.id);
			expect(opened).toMatchObject({ camera: false, state: 'idle' });
			expect(opened).not.toHaveProperty('hms');
			// The cloud cannot move a printer's status to another computer.
			expect(() =>
				open(keys, Buffer.from(entry.sealed as string, 'base64'), 'printers|other')
			).toThrow();
		}
		expect(sim.state().printers).toMatchObject({ control: false, snapshots: false });
	});

	it('pauses, resumes and stops from the phone only with a valid, fresh, unseen MAC', async () => {
		const x2d = t.printer('N6').info.id;
		const job = fleetPrinter('N6').sim;
		job.start({ minutes: 60 });
		await until(() => t.rt.printers.get(x2d)?.snapshot?.gcodeState === 'RUNNING', 'running');

		// Off until a parent turns it on.
		expect(await sim.control(command(x2d, 'pause'))).toEqual({
			ok: false,
			error: 'Remote control is off on the computer.'
		});
		cloud.setRemote({ remoteControl: true });
		await until(() => sim.state().printers?.control === true, 'control announced');

		// Forged: wrong key, changed action, changed printer, too old.
		const other = phoneKeys(Buffer.alloc(32, 7));
		const forged = {
			commandId: randomUUID(),
			printerId: x2d,
			action: 'pause' as const,
			at: Date.now()
		};
		expect(await sim.control({ ...forged, mac: controlMac(other, forged) })).toMatchObject({
			ok: false,
			error: expect.stringMatching(/not signed with this household’s phone key/)
		});
		const stop = command(x2d, 'stop');
		expect(await sim.control({ ...stop, action: 'pause' })).toMatchObject({ ok: false });
		expect(await sim.control(command(x2d, 'pause', { at: Date.now() - 3 * 60_000 }))).toMatchObject(
			{ ok: false, error: expect.stringMatching(/too old/) }
		);
		expect(t.rt.printers.get(x2d)?.snapshot?.gcodeState).toBe('RUNNING');

		const pause = command(x2d, 'pause');
		expect(await sim.control(pause)).toEqual({ ok: true });
		await until(() => job.sim.state.gcode_state === 'PAUSE', 'paused printer');
		expect(t.rt.lab.snapshot().activity[0].message).toMatch(
			/^Paused .+ from the phone, parent@example\.com$/
		);
		// Replayed: the same signed command again is refused, even though it verifies.
		expect(await sim.control(pause)).toMatchObject({
			ok: false,
			error: expect.stringMatching(/already applied/)
		});
		expect(t.rt.lab.snapshot().activity[0].message).toMatch(/Refused a command from the phone/);

		expect(await sim.control(command(x2d, 'resume'))).toEqual({ ok: true });
		await until(() => job.sim.state.gcode_state === 'RUNNING', 'resumed printer');
		expect(await sim.control(command(x2d, 'stop'))).toEqual({ ok: true });
		await until(() => job.sim.state.gcode_state !== 'RUNNING', 'stopped printer');
		// No other actions exist.
		expect(await sim.control({ ...command(x2d, 'pause'), action: 'gcode_line' })).toEqual({
			ok: false,
			error: 'Malformed command.'
		});
	});

	it('needs the Family plan for control', async () => {
		const p1s = t.printer('C12').info.id;
		sim.setPlan(false);
		await until(() => !cloud.status().plan, 'plan off');
		expect(await sim.control(command(p1s, 'pause'))).toEqual({
			ok: false,
			error: 'Remote control is part of the Family plan.'
		});
		await until(() => sim.state().printers?.control === false, 'control withdrawn');
		sim.setPlan(true);
		await until(() => cloud.status().plan, 'plan on');
	});

	it('sends camera pictures sealed for the phone, bound to request, printer and time', async () => {
		const p1s = t.printer('C12').info.id;
		const refused = await sim.snapshot(p1s);
		expect(refused).toMatchObject({ error: 'Camera pictures are off.' });
		expect(refused).not.toHaveProperty('sealed');
		cloud.setRemote({ snapshots: true });
		await until(() => t.rt.module('camera')?.has(p1s), 'camera');
		const answer = await sim.snapshot(p1s, 'req-1');
		expect(answer).toMatchObject({ type: 'snapshot', requestId: 'req-1', printerId: p1s });
		const sealed = Buffer.from(answer.sealed as string, 'base64');
		const capturedAt = answer.capturedAt as number;
		const { jpeg, header } = openSnapshot(keys, sealed, {
			requestId: 'req-1',
			printerId: p1s,
			capturedAt
		});
		expect(isJpeg(jpeg)).toBe(true);
		expect(header).toMatchObject({ printerId: p1s, capturedAt });
		// Swapped printer or request: the phone refuses it.
		const x2d = t.printer('N6').info.id;
		expect(() =>
			openSnapshot(keys, sealed, { requestId: 'req-1', printerId: x2d, capturedAt })
		).toThrow();
		expect(() =>
			openSnapshot(keys, sealed, { requestId: 'req-2', printerId: p1s, capturedAt })
		).toThrow();
		// The sealed picture carries no readable JPEG for the cloud.
		expect(sealed.includes(jpeg.subarray(0, 64))).toBe(false);
		await until(() => sim.state().printers?.snapshots === true, 'snapshots announced');
	});

	it('forgets all phones by making a new key', async () => {
		const before = keys.id;
		const status = cloud.forgetPhones();
		expect(status.phoneKey?.id).not.toBe(before);
		const x2d = t.printer('N6').info.id;
		// A phone with the old key can neither control nor read.
		expect(await sim.control(command(x2d, 'pause'))).toMatchObject({ ok: false });
		await until(
			() =>
				(printers()?.[0]?.sealed as string | undefined)?.length &&
				Buffer.from(printers()![0].sealed as string, 'base64')
					.subarray(4, 12)
					.toString('hex') !== before,
			'resealed'
		);
	});

	it('clears the printers from the cloud when sharing goes off', async () => {
		cloud.setRemote({ shareProgress: false, remoteControl: false, snapshots: false });
		await until(() => printers() === null, 'cleared');
		expect(sim.state().printers).toMatchObject({ control: false, snapshots: false });
	});
});
