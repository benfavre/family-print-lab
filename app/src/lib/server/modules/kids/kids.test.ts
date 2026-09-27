// The kids module in a test lab: limits checked when a child asks (through the ask route), small
// prints said yes to automatically, badges and a gallery photo when a kid's print finishes (with a
// stand-in camera, and without one), kid-mode access to photos, and certificates.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { render } from 'svelte/server';
import { startTestLab, type TestLab } from '../../testing/harness';
import { defineModule } from '../../modules';
import type { CameraService } from '../contracts';
import { makeThing } from '../../kid/things';
import { fakeSliced } from '../../printer/sliced';
import type { KidProfile } from '../../kid/session';
import { kidAccess } from '../../kid/session';
import { POST as ask } from '../../../../routes/api/kid/things/[id]/ask/+server';
import { GET as photo } from '../../../../routes/api/kids/gallery/[id]/image/+server';
import { POST as upload } from '../../../../routes/api/kids/gallery/+server';
import { GET as me } from '../../../../routes/api/kids/me/+server';
import { GET as meCheck } from '../../../../routes/api/kids/me/check/+server';
import { load as certificateLoad } from '../../../../routes/family/certificate/[jobId]/+page.server';
import CertificatePage from '../../../../routes/family/certificate/[jobId]/+page.svelte';
import kidsModule from './module';

// A tiny JPEG stand-in (the gallery checks the JPEG signature, not the picture).
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const snapshots: string[] = [];
const camera = defineModule({
	key: 'camera',
	start: (): CameraService => ({
		has: () => true,
		getSnapshot: async (printerId) => {
			snapshots.push(printerId);
			return JPEG;
		}
	})
});

let t: TestLab;
const holder = globalThis as Record<symbol, unknown>;
const key = Symbol.for('family-print-lab.runtime');

beforeAll(async () => {
	t = await startTestLab({ modules: ['kids', 'camera'], extraModules: [camera] });
	holder[key] = t.rt;
	t.rt.pin.set({ pin: '2468' });
}, 30_000);
afterAll(async () => {
	delete holder[key];
	await t.stop();
});

const kids = () => t.rt.module('kids')!;

function kid(name: string) {
	const id = t.rt.lab.createProfile({ name, color: 'green', age: 8, kid: 'junior' });
	return t.rt.lab.snapshot().profiles.find((p) => p.id === id) as KidProfile;
}

async function call<T>(
	handler: (e: RequestEvent) => Promise<Response> | Response,
	o: { kid?: KidProfile | null; params?: Record<string, string>; body?: unknown; url?: string }
) {
	const res = await handler({
		params: o.params ?? {},
		locals: { kid: o.kid ?? null },
		url: new URL(o.url ?? 'http://localhost/'),
		request: new Request(o.url ?? 'http://localhost/', {
			method: o.body === undefined ? 'GET' : 'POST',
			headers: o.body === undefined ? {} : { 'content-type': 'application/json' },
			body: o.body === undefined ? undefined : JSON.stringify(o.body)
		})
	} as unknown as RequestEvent);
	return {
		status: res.status,
		res,
		body: (res.headers.get('content-type') ?? '').includes('json')
			? ((await res.json()) as T)
			: (null as T)
	};
}

/** A kid's thing, asked for and said yes to: its print job id. */
async function approvedJob(k: KidProfile, template = 'stencil') {
	const made = await makeThing(t.rt, k, template, {});
	const requestId = t.rt.lab.requestPrint(k.id, made.projectId, {});
	return t.rt.lab.decideRequest(requestId, { decision: 'approve', version: 1 })!;
}

/** The printer prints the job and reports it finished (the runtime closes the job first). */
function finish(jobId: string, task: string) {
	const printer = t.printer('N6').info;
	t.rt.lab.transitionJob(jobId, { to: 'Printing', printerTask: task });
	t.rt.bus.emit('print.finished', {
		printerId: printer.id,
		printerName: printer.name,
		jobId,
		task,
		minutes: 12
	});
}

describe('asking within limits', () => {
	it('lets kid mode read only its own pages of the kids API', () => {
		const reads = kidsModule.kidReads!;
		expect(kidAccess('GET', '/api/kids/me', null, reads)).toBe('allow');
		expect(kidAccess('GET', '/api/kids/me/check', null, reads)).toBe('allow');
		expect(kidAccess('GET', '/api/kids/gallery/abc/image', null, reads)).toBe('allow');
		expect(kidAccess('GET', '/api/kids', null, reads)).toBe('refuse');
		expect(kidAccess('GET', '/api/kids/gallery', null, reads)).toBe('refuse');
		expect(kidAccess('PUT', '/api/kids/limits/x', null, reads)).toBe('refuse');
		expect(kidAccess('POST', '/api/kids/gallery', null, reads)).toBe('refuse');
	});

	it('says a kind “not today” once the daily limit is reached', async () => {
		const mia = kid('Mia');
		kids().setLimits(mia.id, { printsPerDay: 1 });
		const one = await makeThing(t.rt, mia, 'stencil', {});
		const two = await makeThing(t.rt, mia, 'treasure-dish', {});
		const first = await call<{ id: string; approved: boolean }>(ask, {
			kid: mia,
			params: { id: one.projectId },
			body: {}
		});
		expect(first.status).toBe(200);
		expect(first.body.approved).toBe(false);
		const limited = t.nextEvent('kid.limit.reached', (e) => e.profileId === mia.id);
		const second = await call<{ error: string }>(ask, {
			kid: mia,
			params: { id: two.projectId },
			body: {}
		});
		expect(second.status).toBe(409);
		expect(second.body.error).toBe('That’s all the printing for today. Ask again tomorrow! 🌙');
		expect((await limited).reason).toBe('day');
		expect((await call<{ blocked: string }>(me, { kid: mia })).body.blocked).toMatch(/today/);

		// The parent sees the usage and the waiting request against the limits.
		const overview = kids()
			.overview()
			.kids.find((k) => k.profileId === mia.id)!;
		expect(overview.usage.printsToday).toBe(1);
		expect(overview.recentRequests[0]).toMatchObject({ status: 'Waiting' });
		expect(overview.recentRequests[0].check?.ok).toBe(true);
		// A waiting request counts towards the limit.
		expect(kids().check(mia.id, 1).ok).toBe(false);
	});

	it('refuses a thing heavier than the filament left this week', async () => {
		const leo = kid('Leo');
		const made = await makeThing(t.rt, leo, 'treasure-dish', {});
		const grams = kids().estimateFor(made.projectId, null);
		expect(grams).toBeGreaterThan(1);
		kids().setLimits(leo.id, { gramsPerWeek: grams - 1 });
		const res = await call<{ error: string }>(ask, {
			kid: leo,
			params: { id: made.projectId },
			body: {}
		});
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/more filament than is left for this week/);
		kids().setLimits(leo.id, { gramsPerWeek: grams });
		expect((await call(ask, { kid: leo, params: { id: made.projectId }, body: {} })).status).toBe(
			200
		);
	});

	it('keeps limits to kids and checks only a child’s own things', async () => {
		const dad = t.rt.lab.createProfile({ name: 'Dad', color: 'orange' });
		expect(() => kids().setLimits(dad, { printsPerDay: 1 })).toThrow(/kid mode/);
		const sam = kid('Sam');
		const tia = kid('Tia');
		kids().setLimits(sam.id, { printsPerDay: 0 });
		const hers = await makeThing(t.rt, tia, 'stencil', {});
		// Sam cannot ask for (or probe the limits with) Tia's thing: the same 404 as the lab gives.
		const asked = await call<{ error: string }>(ask, {
			kid: sam,
			params: { id: hers.projectId },
			body: {}
		});
		expect(asked).toMatchObject({ status: 404, body: { error: 'That project no longer exists.' } });
		const probe = await call(meCheck, {
			kid: sam,
			url: `http://localhost/api/kids/me/check?project=${hers.projectId}`
		});
		expect(probe.status).toBe(404);
		const mine = await makeThing(t.rt, sam, 'stencil', {});
		const own = await call<{ ok: boolean; message: string }>(meCheck, {
			kid: sam,
			url: `http://localhost/api/kids/me/check?project=${mine.projectId}`
		});
		expect(own.body).toMatchObject({ ok: false, message: expect.stringMatching(/today/) });
	});

	it('says yes on its own to small prints when the parent allowed it', async () => {
		const ada = kid('Ada');
		const made = await makeThing(t.rt, ada, 'stencil', {});
		kids().setLimits(ada.id, { needApprovalOverGrams: 1000 });
		const res = await call<{ id: string; approved: boolean }>(ask, {
			kid: ada,
			params: { id: made.projectId },
			body: {}
		});
		expect(res.body.approved).toBe(true);
		const request = t.rt.lab.snapshot().printRequests.find((r) => r.id === res.body.id)!;
		expect(request).toMatchObject({ status: 'Approved', reply: 'Yes! Small prints can go ahead.' });
		expect(t.rt.lab.getJob(request.jobId!)?.status).toBe('Queued');
	});
});

describe('when a kid’s print finishes', () => {
	it('earns a badge and invites a photo when camera photos are off', async () => {
		const zoe = kid('Zoe');
		const jobId = await approvedJob(zoe);
		const badge = t.nextEvent('kid.badge.earned', (e) => e.profileId === zoe.id);
		const wanted = t.nextEvent('kid.photo.wanted', (e) => e.profileId === zoe.id);
		finish(jobId, 'zoe-1');
		expect(t.rt.lab.getJob(jobId)?.status).toBe('Succeeded');
		expect(await badge).toMatchObject({ badge: 'first-print', jobId });
		expect(await wanted).toMatchObject({ jobId });
		expect(
			kids()
				.photosWanted()
				.map((p) => p.jobId)
		).toContain(jobId);
		expect(snapshots).toHaveLength(0);

		// A grown-up uploads one instead; the invitation goes away.
		const res = await call<{ item: { id: string; caption: string } }>(upload, {
			body: { jobId, image: `data:image/jpeg;base64,${JPEG.toString('base64')}` }
		});
		expect(res.status).toBe(200);
		expect(res.body.item.caption).toBe('Drawing stencil');
		expect(
			kids()
				.photosWanted()
				.map((p) => p.jobId)
		).not.toContain(jobId);
	});

	it('takes a photo with the printer camera when the parent turned it on', async () => {
		kids().setSettings({ snapshots: true });
		const ben = kid('Ben');
		const other = kid('Ivy');
		const jobId = await approvedJob(ben);
		const added = t.nextEvent('kid.photo.added', (e) => e.profileId === ben.id);
		finish(jobId, 'ben-1');
		const { itemId } = await added;
		expect(snapshots).toContain(t.printer('N6').info.id);
		const item = kids()
			.gallery(ben.id)
			.find((g) => g.id === itemId)!;
		expect(item).toMatchObject({ jobId, source: 'camera', projectTitle: 'Drawing stencil' });

		// The picture: for grown-ups, and in kid mode only for its maker.
		const parent = await call(photo, { params: { id: itemId } });
		expect(parent.status).toBe(200);
		expect(parent.res.headers.get('content-type')).toBe('image/jpeg');
		expect(Buffer.from(await parent.res.arrayBuffer())).toEqual(JPEG);
		expect((await call(photo, { kid: ben, params: { id: itemId } })).status).toBe(200);
		expect((await call(photo, { kid: other, params: { id: itemId } })).status).toBe(404);
		const self = await call<{ gallery: { id: string }[]; badges: { badge: string }[] }>(me, {
			kid: ben
		});
		expect(self.body.gallery.map((g) => g.id)).toEqual([itemId]);
		expect(self.body.badges.map((b) => b.badge)).toEqual(['first-print']);

		// And a printable certificate with the photo and the badge.
		const data = (await certificateLoad({ params: { jobId } } as never)) as {
			certificate: import('$lib/shared/kids').Certificate;
		};
		expect(data.certificate).toMatchObject({
			kidName: 'Ben',
			projectTitle: 'Drawing stencil',
			photoId: itemId
		});
		expect(data.certificate.badges.map((b) => b.id)).toEqual(['first-print']);
		const html = render(CertificatePage, { props: { data } }).body;
		expect(html).toContain('Certificate of making');
		expect(html).toContain('Ben');
		expect(html).toContain('Drawing stencil');
		expect(html).toContain(`/api/kids/gallery/${itemId}/image`);
		expect(html).toContain('First print');
		kids().setSettings({ snapshots: false });
	});

	it('follows a real print on the simulated printer: two colours earn a badge and a photo', async () => {
		kids().setSettings({ snapshots: true });
		const noa = kid('Noa');
		const jobId = await approvedJob(noa);
		t.rt.printing.attach(
			jobId,
			fakeSliced({
				minutes: 1,
				grams: 8,
				printerModelId: 'N6',
				filaments: [
					{ type: 'PLA', color: '#FF0000', grams: 4 },
					{ type: 'PETG', color: '#0000FF', grams: 4 }
				]
			}),
			'stencil.gcode.3mf'
		);
		const printer = t.printer('N6').info;
		const added = t.nextEvent('kid.photo.added', (e) => e.profileId === noa.id, 25_000);
		t.rt.printing.send(jobId, { printerId: printer.id, useAms: true, amsMapping: [0, 1] });
		await added;
		expect(t.rt.lab.getJob(jobId)?.status).toBe('Succeeded');
		expect(
			kids()
				.badges(noa.id)
				.map((b) => b.badge)
				.sort()
		).toEqual(['first-print', 'multi-colour']);
		expect(kids().gallery(noa.id)[0]).toMatchObject({ jobId, source: 'camera' });
		kids().setSettings({ snapshots: false });
	}, 30_000);

	it('stops inviting a photo once the grown-up says no photo', async () => {
		const una = kid('Una');
		const jobId = await approvedJob(una);
		finish(jobId, 'una-1');
		const wanted = () =>
			kids()
				.photosWanted()
				.map((p) => p.jobId);
		expect(wanted()).toContain(jobId);
		kids().dismissPhoto(jobId);
		expect(wanted()).not.toContain(jobId);
		expect(() => kids().dismissPhoto('no-such-job')).toThrow(/no longer exists/);
	});

	it('takes one camera photo at a time when a grown-up asks', async () => {
		const eli = kid('Eli');
		const jobId = await approvedJob(eli);
		finish(jobId, 'eli-1');
		const first = kids().captureNow(jobId);
		await expect(kids().captureNow(jobId)).rejects.toMatchObject({ status: 409 });
		expect((await first).source).toBe('camera');
		expect(kids().gallery(eli.id)).toHaveLength(1);
	});

	it('earns badges for a job marked as printed by hand', async () => {
		const max = kid('Max');
		const jobId = await approvedJob(max);
		const badge = t.nextEvent('kid.badge.earned', (e) => e.profileId === max.id);
		// No printer involved: the grown-up marks it printed on the Print jobs page.
		t.rt.lab.transitionJob(jobId, { to: 'Printing' });
		t.rt.lab.transitionJob(jobId, { to: 'Succeeded' });
		// No wait: SvelteKit can prefetch the certificate as soon as the transition completes.
		expect(
			kids()
				.certificate(jobId)
				?.badges.map((b) => b.id)
		).toContain('first-print');
		expect(await badge).toMatchObject({ badge: 'first-print', jobId });
		expect(
			kids()
				.overview()
				.kids.find((k) => k.profileId === max.id)?.printsLastWeek
		).toBe(1);
	});

	it('has no certificate before the print finished', async () => {
		const jobId = await approvedJob(kid('Kai'));
		await expect(async () => certificateLoad({ params: { jobId } } as never)).rejects.toMatchObject(
			{ status: 404 }
		);
	});

	it('leaves grown-ups’ prints alone', async () => {
		const mum = t.rt.lab.createProfile({ name: 'Mum', color: 'blue' });
		const projectId = t.rt.lab.createProject({ profileId: mum, title: 'Shelf bracket' });
		const jobId = t.rt.lab.createJob({ projectId });
		finish(jobId, 'mum-1');
		expect(t.rt.lab.getJob(jobId)?.status).toBe('Succeeded');
		expect(kids().badges(mum)).toEqual([]);
		expect(
			kids()
				.photosWanted()
				.map((p) => p.jobId)
		).not.toContain(jobId);
	});
});
