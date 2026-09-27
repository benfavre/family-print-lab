import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import example, { stops } from './modules/__test__/module';
import { defineModule, hookList, startModules, stopModules, type ServerModule } from './modules';
import { moduleSettings } from './module-settings';
import { startTestLab } from './testing/harness';
import { integrations } from './integrations';
import { kidAccess } from './kid/session';
import { openDatabase } from './db';
import { fakeSliced } from './printer/sliced';

describe('server modules', () => {
	it('start in order, stay off when they fail, and stop in reverse', async () => {
		const log: string[] = [];
		const seen: string[] = [];
		const mod = (key: string, order: number, fail = false): ServerModule =>
			defineModule({
				key,
				order,
				start: () => {
					if (fail) throw new Error('broken');
					seen.push(key);
					return key.toUpperCase();
				},
				stop: () => void seen.push(`stop ${key}`)
			});
		const services = new Map<string, unknown>();
		const loaded = startModules(
			[mod('b', 20), mod('a', 10), mod('c', 30, true), mod('a', 40)],
			() => ({}) as never,
			{ log: (m) => log.push(m), services }
		);
		expect(loaded.map((m) => [m.module.key, m.state])).toEqual([
			['a', 'started'],
			['b', 'started'],
			['c', 'failed'],
			['a', 'skipped']
		]);
		expect(services.get('b')).toBe('B');
		expect(log.join('\n')).toMatch(/c could not start: broken/);
		await stopModules(loaded, (m) => log.push(m));
		expect(seen).toEqual(['a', 'b', 'stop b', 'stop a']);
		expect(
			startModules([mod('x', 1)], () => ({}) as never, { only: [], log: () => {}, services }).map(
				(m) => m.state
			)
		).toEqual(['skipped']);
	});

	it('keeps settings in meta, with defaults when missing or invalid', () => {
		const db = openDatabase(':memory:');
		const store = moduleSettings(db, 'ntfy', z.object({ topic: z.string().min(3) }), {
			topic: 'lab'
		});
		expect(store.key).toBe('settings:ntfy');
		expect(store.get()).toEqual({ topic: 'lab' });
		expect(store.set({ topic: 'family' })).toEqual({ topic: 'family' });
		expect(store.get()).toEqual({ topic: 'family' });
		expect(() => store.set({ topic: 'x' })).toThrow();
		db.$client.prepare(`UPDATE meta SET value = '{"topic":1}' WHERE key = 'settings:ntfy'`).run();
		expect(store.get()).toEqual({ topic: 'lab' });
	});

	it('hook lists run in order and can be removed', async () => {
		const list = hookList<() => string>();
		const off = list.add(() => 'a');
		list.add(() => 'b');
		expect(list.size).toBe(2);
		off();
		expect(list.list().map((f) => f())).toEqual(['b']);
	});

	it('a module dropped in gets bus events, settings, a service, an Integrations row and kid reads', async () => {
		const t = await startTestLab({ fleet: ['C12'], modules: ['example'], extraModules: [example] });
		try {
			// Package modules found by the glob stay off ('skipped') when a test names the ones it wants.
			expect(t.rt.modules().filter((m) => m.state !== 'skipped')).toEqual([
				{ key: 'example', state: 'started', error: undefined }
			]);
			const service = t.rt.module('example')!;
			expect(service.greeting()).toBe('Hello');
			// A print finishes on the simulated P1S: the lab closes its job first, then the module hears it.
			const { lab, printing } = t.rt;
			const profileId = lab.createProfile({ name: 'Ana', color: 'pink' });
			const projectId = lab.createProject({ profileId, title: 'Badge' });
			const jobId = lab.createJob({ projectId });
			printing.attach(
				jobId,
				fakeSliced({ minutes: 1, grams: 3, printerModelId: 'C12' }),
				'b.gcode.3mf'
			);
			const hello = t.nextEvent('example.hello');
			printing.send(jobId, { useAms: true, amsMapping: [0] });
			expect(await hello).toMatchObject({ text: 'Hello, print done' });
			expect(service.finished()).toBe(1);
			expect(lab.getJob(jobId)?.status).toBe('Succeeded');
			const report = await integrations(t.rt, true);
			expect(report.items.find((i) => i.id === 'example')).toMatchObject({
				kind: 'module',
				available: true
			});
			const reads = t.rt.loadedModules().flatMap((m) => m.module.kidReads ?? []);
			expect(kidAccess('GET', '/api/example/public', null, reads)).toBe('allow');
			expect(kidAccess('GET', '/api/example/private', null, reads)).toBe('refuse');
		} finally {
			await t.stop();
		}
		expect(stops()).toBe(1);
	});
});
