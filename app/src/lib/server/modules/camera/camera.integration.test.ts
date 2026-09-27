// The camera package against a simulated fleet (X2D, P1S, A1 mini): live view and snapshots for every
// model, the routes, camera commands, and the timelapse folder over the printer's file service.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { startTestLab, type TestLab } from '$lib/server/testing/harness';
import { isJpeg } from './jpeg6000';
import { BOUNDARY } from './mjpeg';
import { GET as stateRoute } from '../../../../routes/api/printers/[id]/camera/+server';
import { GET as streamRoute } from '../../../../routes/api/printers/[id]/camera/stream/+server';
import { GET as snapshotRoute } from '../../../../routes/api/printers/[id]/camera/snapshot.jpg/+server';
import { GET as filesRoute } from '../../../../routes/api/printers/[id]/files/+server';
import { GET as downloadRoute } from '../../../../routes/api/printers/[id]/files/download/+server';
import {
	GET as getSettings,
	PUT as putSettings
} from '../../../../routes/api/camera/settings/+server';
import type { CameraState, MediaListing } from '$lib/shared/camera';

let t: TestLab;
const holder = globalThis as Record<symbol, unknown>;
const key = Symbol.for('family-print-lab.runtime');

beforeAll(async () => {
	t = await startTestLab({ modules: ['camera'], fleet: ['N6', 'C12', 'N1'] });
	holder[key] = t.rt;
	// The simulated cameras report their port shortly after start.
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const ok = ['N6', 'C12', 'N1'].every((m) =>
			t.rt.module('camera')!.has(t.printer(m as 'N6').info.id)
		);
		if (ok) break;
		await new Promise((r) => setTimeout(r, 20));
	}
});
afterAll(async () => {
	delete holder[key];
	await t?.stop();
});

function event(id: string, path: string, init?: RequestInit) {
	const url = new URL(`http://localhost${path}`);
	return {
		params: { id },
		url,
		request: new Request(url, init)
	} as unknown as RequestEvent;
}

describe('camera on the simulated fleet', () => {
	it('is available for every model', async () => {
		for (const model of ['N6', 'C12', 'N1'] as const) {
			const id = t.printer(model).info.id;
			const res = await stateRoute(event(id, `/api/printers/${id}/camera`));
			const state = (await res.json()) as CameraState;
			expect(state).toMatchObject({ available: true, path: 'jpeg', simulated: true });
		}
		// The X2D's report looks like a real one with LAN Only Liveview on.
		expect(t.rt.printers.get(t.printer('N6').info.id)!.camera()).toBe('rtsps');
	});

	it('serves a snapshot JPEG from each printer', async () => {
		for (const model of ['N6', 'C12', 'N1'] as const) {
			const id = t.printer(model).info.id;
			const res = await snapshotRoute(event(id, `/api/printers/${id}/camera/snapshot.jpg`));
			expect(res.status).toBe(200);
			expect(res.headers.get('content-type')).toBe('image/jpeg');
			expect(isJpeg(Buffer.from(await res.arrayBuffer()))).toBe(true);
		}
		const id = t.printer('N1').info.id;
		const saved = await snapshotRoute(
			event(id, `/api/printers/${id}/camera/snapshot.jpg?download=1`)
		);
		expect(saved.headers.get('content-disposition')).toMatch(/^attachment; filename=".*\.jpg"/);
	});

	it('streams multipart JPEG frames until the viewer leaves', async () => {
		const id = t.printer('C12').info.id;
		const abort = new AbortController();
		const res = await streamRoute(
			event(id, `/api/printers/${id}/camera/stream`, { signal: abort.signal })
		);
		expect(res.headers.get('content-type')).toBe(`multipart/x-mixed-replace; boundary=${BOUNDARY}`);
		const reader = res.body!.getReader();
		let text = '';
		while ((text.match(new RegExp(`--${BOUNDARY}`, 'g')) ?? []).length < 2) {
			const { value, done } = await reader.read();
			if (done) break;
			text += Buffer.from(value).toString('latin1');
		}
		expect(text).toContain('Content-Type: image/jpeg');
		abort.abort();
		await reader.cancel();
		expect(t.rt.module('camera')!.state(id).live).toBe(true);
	});

	it('explains when LAN liveview is off, and refuses the stream', async () => {
		const { info, sim } = t.printer('N1');
		const cam = sim.state.ipcam;
		cam.liveview = { local: 'disabled' };
		sim.report();
		const deadline = Date.now() + 3000;
		while (Date.now() < deadline && t.rt.module('camera')!.has(info.id))
			await new Promise((r) => setTimeout(r, 20));
		const state = t.rt.module('camera')!.state(info.id);
		expect(state).toMatchObject({ available: false, reason: 'liveview-off' });
		const res = await streamRoute(event(info.id, `/api/printers/${info.id}/camera/stream`));
		expect(res.status).toBe(409);
		expect((await res.json()).error).toMatch(/LAN Only Liveview/);
		cam.liveview = { local: 'local' };
		sim.report();
	});

	it('toggles timelapse recording on the printer', async () => {
		const id = t.printer('N6').info.id;
		const printer = t.rt.printers.require(id);
		expect((await printer.send('camera.ipcam_timelapse', { on: true })).outcome).toBe('confirmed');
		expect(printer.snapshot?.camera.timelapse).toBe(true);
		await printer.send('camera.ipcam_timelapse', { on: false });
		expect(printer.snapshot?.camera.timelapse).toBe(false);
		await printer.send('camera.ipcam_record_set', { on: false });
		expect(printer.snapshot?.camera.recording).toBe(false);
	});

	it('lists timelapses with thumbnails and streams a download', async () => {
		const id = t.printer('C12').info.id;
		const res = await filesRoute(event(id, `/api/printers/${id}/files`));
		const listing = (await res.json()) as MediaListing;
		expect(listing.dir).toBe('/timelapse');
		const videos = listing.entries.filter((e) => e.kind === 'video');
		expect(videos).toHaveLength(2);
		expect(videos[0].thumbnail).toMatch(/^\/timelapse\/thumbnail\/video_.*\.jpg$/);
		expect(listing.note).toBeNull();

		const file = await downloadRoute(
			event(id, `/api/printers/${id}/files/download?path=${encodeURIComponent(videos[0].path)}`)
		);
		expect(file.status).toBe(200);
		expect(file.headers.get('content-type')).toBe('video/mp4');
		expect(file.headers.get('content-disposition')).toMatch(/^attachment;/);
		const body = Buffer.from(await file.arrayBuffer());
		expect(body.length).toBe(Number(file.headers.get('content-length')));
		expect(body.subarray(4, 8).toString()).toBe('ftyp');

		const thumb = await downloadRoute(
			event(
				id,
				`/api/printers/${id}/files/download?inline=1&path=${encodeURIComponent(videos[0].thumbnail!)}`
			)
		);
		expect(thumb.headers.get('content-disposition')).toMatch(/^inline;/);
		expect(isJpeg(Buffer.from(await thumb.arrayBuffer()))).toBe(true);
	});

	it('refuses paths outside what the folder lists', async () => {
		const id = t.printer('C12').info.id;
		const get = (path: string) =>
			downloadRoute(
				event(id, `/api/printers/${id}/files/download?path=${encodeURIComponent(path)}`)
			);
		expect((await get('/timelapse/../secret')).status).toBe(400);
		expect((await get('/timelapse/nope.mp4')).status).toBe(404);
		expect((await get('/timelapse/x\r\nDELE /y')).status).toBe(400);
		const dir = await filesRoute(event(id, `/api/printers/${id}/files?dir=/nowhere`));
		expect(dir.status).toBe(404);
	});

	it('adds a timelapse when a print finishes with timelapse on', async () => {
		const { info, sim } = t.printer('N1');
		const printer = t.rt.printers.require(info.id);
		await printer.send('camera.ipcam_timelapse', { on: true });
		sim.print.start({ minutes: 1 });
		sim.print.finish();
		// The feature notices the change on its next step.
		const deadline = Date.now() + 3000;
		let count = 0;
		while (Date.now() < deadline) {
			const listing = await t.rt.module('camera')!.media.list(printer, '/timelapse');
			count = listing.entries.filter((e) => e.kind === 'video').length;
			if (count === 3) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		expect(count).toBe(3);
	});

	it('keeps the "show on cards" setting', async () => {
		expect(await (await getSettings(event('', '/api/camera/settings'))).json()).toEqual({
			showOnCards: false
		});
		const res = await putSettings(
			event('', '/api/camera/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ showOnCards: true })
			})
		);
		expect((await res.json()).settings).toEqual({ showOnCards: true });
		const bad = await putSettings(
			event('', '/api/camera/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ showOnCards: 'yes' })
			})
		);
		expect(bad.status).toBe(400);
	});
});
