import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { openDatabase, type DB } from '../db';
import { meta } from '../db/schema';
import { Lab } from '../lab';
import { CONTROL_WINDOW, controlMac, newPhoneKey, phoneKeys } from './phone';
import { Remote, type CloudHost } from './remote';
import { ReplayCache } from './replay';
import { emptySnapshot } from '$lib/shared/printers/status';

const NOW = 1_790_000_000_000;
const KEY = 'cloud.remote.replay';
const dirs: string[] = [];
const databases: DB[] = [];

function database(file = ':memory:') {
	const db = openDatabase(file);
	databases.push(db);
	return db;
}

function diskDatabase() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-replay-'));
	dirs.push(dir);
	return path.join(dir, 'lab.db');
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const db of databases.splice(0)) if (db.$client.open) db.$client.close();
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('durable remote command claims', () => {
	it('retains future-dated commands through their inclusive expiry after reopening the database', () => {
		const file = diskDatabase();
		const first = database(file);
		expect(new ReplayCache(first).remember('future', NOW + CONTROL_WINDOW, NOW)).toBe('accepted');
		first.$client.close();
		const cache = new ReplayCache(database(file));
		expect(cache.remember('future', NOW + CONTROL_WINDOW, NOW)).toBe('replay');
		expect(cache.remember('future', NOW + CONTROL_WINDOW, NOW + CONTROL_WINDOW * 2)).toBe('replay');
		expect(cache.remember('new', NOW + CONTROL_WINDOW * 2 + 1, NOW + CONTROL_WINDOW * 2 + 1)).toBe(
			'accepted'
		);
	});

	it('refuses capacity overflow without evicting valid ids, then reclaims expired entries', () => {
		const db = database();
		const cache = new ReplayCache(db, 2);
		expect(cache.remember('future', NOW + CONTROL_WINDOW, NOW)).toBe('accepted');
		expect(cache.remember('past', NOW - CONTROL_WINDOW, NOW)).toBe('accepted');
		expect(cache.remember('new', NOW, NOW)).toBe('full');
		expect(new ReplayCache(db, 2).remember('future', NOW + CONTROL_WINDOW, NOW)).toBe('replay');
		// Expiry order differs from insertion order when phones have different clock offsets.
		expect(cache.remember('new', NOW + 1, NOW + 1)).toBe('accepted');
		expect(cache.remember('future', NOW + CONTROL_WINDOW, NOW + 1)).toBe('replay');
	});

	it('shares claims between independent database connections', () => {
		const file = diskDatabase();
		const first = new ReplayCache(database(file));
		const second = new ReplayCache(database(file));
		expect(first.remember('one', NOW, NOW)).toBe('accepted');
		expect(second.remember('one', NOW, NOW)).toBe('replay');
		expect(second.remember('two', NOW, NOW)).toBe('accepted');
		expect(first.remember('two', NOW, NOW)).toBe('replay');
	});
});

describe('remote control across restarts', () => {
	function setup() {
		vi.spyOn(Date, 'now').mockReturnValue(NOW);
		const file = diskDatabase();
		const keys = phoneKeys(newPhoneKey());
		const send = vi.fn(async () => {});
		const host = Object.assign(new EventEmitter(), {
			statuses: () => [
				{
					id: 'printer',
					configured: true,
					connected: true,
					state: emptySnapshot({ gcodeState: 'RUNNING' })
				}
			],
			send
		}) as CloudHost;
		const start = () => {
			const db = database(file);
			return {
				db,
				remote: new Remote(
					host,
					new Lab(db),
					() => ({
						shareProgress: true,
						shareAlerts: false,
						shareQueue: false,
						snapshots: false,
						remoteControl: true
					}),
					() => keys,
					() => true,
					() => {}
				)
			};
		};
		const command = (commandId: string, at = NOW) => {
			const fields = { commandId, printerId: 'printer', action: 'pause' as const, at };
			return { ...fields, mac: controlMac(keys, fields) };
		};
		return { start, send, command };
	}

	it.each([0, CONTROL_WINDOW])(
		'rejects a replay after a same-millisecond restart (clock offset %i)',
		async (offset) => {
			const { start, send, command } = setup();
			const first = start();
			const signed = command('command-one', NOW + offset);
			expect(await first.remote.control(signed)).toEqual({ ok: true });
			first.remote.stop();
			first.db.$client.close();
			const restarted = start();
			expect(await restarted.remote.control(signed)).toMatchObject({
				ok: false,
				error: expect.stringMatching(/already applied/)
			});
			expect(send).toHaveBeenCalledTimes(1);
			expect(await restarted.remote.control(command('command-two'))).toEqual({ ok: true });
			expect(send).toHaveBeenCalledTimes(2);
		}
	);

	it('commits before dispatch and consumes failed sends so an uncertain outcome is never retried', async () => {
		const { start, send, command } = setup();
		const first = start();
		const signed = command('failed-command');
		send.mockImplementationOnce(async () => {
			const other = start();
			expect(await other.remote.control(signed)).toMatchObject({
				ok: false,
				error: expect.stringMatching(/already applied/)
			});
			throw new Error('Lost the printer connection after sending');
		});
		expect(await first.remote.control(signed)).toMatchObject({ ok: false });
		first.db.$client.close();
		expect(await start().remote.control(signed)).toMatchObject({
			ok: false,
			error: expect.stringMatching(/already applied/)
		});
		expect(send).toHaveBeenCalledTimes(1);
	});

	it('does not send a command when the replay claim cannot be written', async () => {
		const { start, send, command } = setup();
		const { db, remote } = start();
		db.$client.pragma('query_only = ON');
		const signed = command('write-failure');
		expect(await remote.control(signed)).toEqual({
			ok: false,
			error: 'Remote control could not save the command. Try again later.'
		});
		expect(send).not.toHaveBeenCalled();
		db.$client.pragma('query_only = OFF');
		expect(await remote.control(signed)).toEqual({ ok: true });
	});

	it.each(['not json', '{}', '[["bad",null]]'])(
		'refuses control with a damaged replay cache: %s',
		async (value) => {
			const { start, send, command } = setup();
			const { db, remote } = start();
			db.insert(meta).values({ key: KEY, value }).run();
			expect(await remote.control(command('damaged-cache'))).toMatchObject({
				ok: false,
				error: expect.stringMatching(/could not save/)
			});
			expect(send).not.toHaveBeenCalled();
			expect(db.select().from(meta).where(eq(meta.key, KEY)).get()?.value).toBe(value);
		}
	);

	it('does not claim forged or stale commands', async () => {
		const { start, send, command } = setup();
		const { db, remote } = start();
		expect(
			await remote.control({ ...command('forged-command'), mac: '0'.repeat(64) })
		).toMatchObject({ ok: false });
		expect(await remote.control(command('stale-command', NOW - CONTROL_WINDOW - 1))).toMatchObject({
			ok: false
		});
		expect(db.select().from(meta).where(eq(meta.key, KEY)).get()).toBeUndefined();
		expect(send).not.toHaveBeenCalled();
	});
});
