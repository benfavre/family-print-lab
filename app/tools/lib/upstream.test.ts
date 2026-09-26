import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UPSTREAM_PRINTERS } from '../../src/lib/shared/printers/models.generated';
import {
	githubRepo,
	parseLock,
	readUpstreamLock,
	repoRoot,
	upstreamFile,
	upstreamList
} from './upstream';

const SHA = '926a7192574bcb9b3a732e1ec59a46d79cb45466';
const lockText = (over: Record<string, string> = {}) =>
	Object.entries({
		name: 'BambuStudio',
		url: 'https://github.com/bambulab/BambuStudio.git',
		tag: 'v02.08.02.61',
		commit: SHA,
		...over
	})
		.map(([k, v]) => `${k}=${v}`)
		.join('\n');

const temps: string[] = [];
const tempDir = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpl-upstream-'));
	temps.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

const run = (dir: string, ...args: string[]) =>
	execFileSync('git', ['-C', dir, ...args], {
		env: {
			...process.env,
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_CONFIG_GLOBAL: '/dev/null',
			GIT_AUTHOR_NAME: 't',
			GIT_AUTHOR_EMAIL: 't@example.invalid',
			GIT_COMMITTER_NAME: 't',
			GIT_COMMITTER_EMAIL: 't@example.invalid'
		}
	})
		.toString()
		.trim();

/** A repository with slicer/upstream.lock and a git checkout in slicer/.upstream at two commits. */
function fixture() {
	const root = tempDir();
	const up = path.join(root, 'slicer', '.upstream');
	fs.mkdirSync(path.join(up, 'resources', 'printers'), { recursive: true });
	run(up, 'init', '--quiet');
	fs.writeFileSync(path.join(up, 'resources', 'printers', 'A.json'), '{"v":1}');
	run(up, 'add', '-A');
	run(up, 'commit', '--quiet', '-m', 'v1');
	const v1 = run(up, 'rev-parse', 'HEAD');
	fs.writeFileSync(path.join(up, 'resources', 'printers', 'A.json'), '{"v":2}');
	fs.writeFileSync(path.join(up, 'resources', 'printers', 'B.json'), '{}');
	run(up, 'add', '-A');
	run(up, 'commit', '--quiet', '-m', 'v2');
	const v2 = run(up, 'rev-parse', 'HEAD');
	const pin = (commit: string) =>
		fs.writeFileSync(path.join(root, 'slicer', 'upstream.lock'), lockText({ commit }));
	pin(v1);
	return { root, up, v1, v2, pin };
}

describe('parseLock', () => {
	it('reads the lock with comments and defaults', () => {
		const lock = parseLock(`# a comment\n${lockText()}   # trailing\nqueue=3\n`);
		expect(lock).toEqual({
			name: 'BambuStudio',
			url: 'https://github.com/bambulab/BambuStudio.git',
			tag: 'v02.08.02.61',
			commit: SHA,
			queue: 3,
			queueHash: ''
		});
		expect(parseLock(lockText()).queue).toBe(0);
	});

	it('keeps a # that is part of a value', () => {
		expect(parseLock(lockText({ url: 'https://x.example/y.git#main' })).url).toBe(
			'https://x.example/y.git#main'
		);
	});

	it('rejects a missing key or a short commit', () => {
		for (const key of ['name', 'url', 'tag', 'commit'])
			expect(() => parseLock(lockText({ [key]: '' }))).toThrow(`missing "${key}"`);
		expect(() => parseLock(lockText({ commit: SHA.slice(0, 12) }))).toThrow('40-character');
	});
});

describe('readUpstreamLock', () => {
	it('fails loudly when there is no lock (no second copy of the pin)', () => {
		expect(() => readUpstreamLock(tempDir())).toThrow('slicer/upstream.lock not found');
		expect(() => readUpstreamLock(null)).toThrow('slicer/upstream.lock not found');
	});

	it('the generated model catalogue matches the pin', () => {
		// Bumping the lock without rerunning tools/gen-printer-models.ts fails here.
		const lock = readUpstreamLock(repoRoot(import.meta.dirname));
		expect(UPSTREAM_PRINTERS).toEqual({ tag: lock.tag, commit: lock.commit });
	});
});

describe('githubRepo', () => {
	it('derives owner and repository from the lock url', () => {
		expect(githubRepo('https://github.com/bambulab/BambuStudio.git')).toEqual({
			owner: 'bambulab',
			repo: 'BambuStudio'
		});
		expect(githubRepo('https://github.com/someone/Bambu.Fork')).toEqual({
			owner: 'someone',
			repo: 'Bambu.Fork'
		});
		expect(() => githubRepo('https://gitlab.com/a/b.git')).toThrow('not a GitHub repository');
	});
});

describe('upstreamFile and upstreamList', () => {
	it('downloads from the lock url at the pinned commit and caches outside app/resources', async () => {
		const root = tempDir();
		fs.mkdirSync(path.join(root, 'slicer'));
		fs.writeFileSync(
			path.join(root, 'slicer', 'upstream.lock'),
			lockText({ url: 'https://github.com/someone/Fork.git' })
		);
		const fetch = vi.fn(async () => new Response('{"ok":1}'));
		const opts = { root, fetch: fetch as unknown as typeof globalThis.fetch };
		expect((await upstreamFile('resources/printers/X.json', opts)).toString()).toBe('{"ok":1}');
		expect(fetch).toHaveBeenCalledWith(
			`https://raw.githubusercontent.com/someone/Fork/${SHA}/resources/printers/X.json`,
			expect.anything()
		);
		const cached = path.join(root, 'slicer', '.build', 'upstream-cache', SHA, 'resources');
		expect(fs.existsSync(path.join(cached, 'printers', 'X.json'))).toBe(true);
		expect(fs.existsSync(path.join(root, 'app'))).toBe(false);
		await upstreamFile('resources/printers/X.json', opts);
		expect(fetch).toHaveBeenCalledTimes(1);
		await upstreamFile('resources/printers/X.json', { ...opts, refresh: true });
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('lists a directory through the contents API of the lock repository', async () => {
		const root = tempDir();
		fs.mkdirSync(path.join(root, 'slicer'));
		fs.writeFileSync(path.join(root, 'slicer', 'upstream.lock'), lockText());
		const fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify([
						{ name: 'b.json', type: 'file' },
						{ name: 'a.json', type: 'file' },
						{ name: 'sub', type: 'dir' }
					])
				)
		);
		const names = await upstreamList('resources/printers', {
			root,
			fetch: fetch as unknown as typeof globalThis.fetch
		});
		expect(names).toEqual(['a.json', 'b.json']);
		expect(fetch).toHaveBeenCalledWith(
			`https://api.github.com/repos/bambulab/BambuStudio/contents/resources/printers?ref=${SHA}`,
			expect.anything()
		);
	});

	it('refuses paths outside the tree', async () => {
		await expect(upstreamFile('../x', { root: null })).rejects.toThrow('Not an upstream path');
		await expect(upstreamFile('/etc/passwd', { root: null })).rejects.toThrow(
			'Not an upstream path'
		);
	});

	it('reads a local checkout at the pinned commit, not its working tree', async () => {
		const { root, up, v1 } = fixture();
		// The checkout is at v2 (as after `upstream.sh rebase` before `export`), the lock pins v1.
		expect((await upstreamFile('resources/printers/A.json', { root })).toString()).toBe('{"v":1}');
		expect(await upstreamList('resources/printers', { root })).toEqual(['A.json']);
		// A local edit is not served either.
		fs.writeFileSync(path.join(up, 'resources', 'printers', 'A.json'), 'edited');
		expect((await upstreamFile('resources/printers/A.json', { root })).toString()).toBe('{"v":1}');
		expect(run(up, 'rev-parse', 'HEAD')).not.toBe(v1);
	});

	it('refuses a checkout that does not have the pinned commit', async () => {
		const { root, v2 } = fixture();
		fs.writeFileSync(path.join(root, 'slicer', 'upstream.lock'), lockText());
		await expect(upstreamFile('resources/printers/A.json', { root })).rejects.toThrow(
			`slicer/.upstream is at ${v2.slice(0, 12)}, but slicer/upstream.lock pins v02.08.02.61 (926a7192574b): run slicer/scripts/upstream.sh fetch.`
		);
	});

	it('names printlab-base as the checkout version when upstream.sh made it', async () => {
		const { root, up, v1 } = fixture();
		run(up, 'tag', 'printlab-base', v1);
		fs.writeFileSync(path.join(root, 'slicer', 'upstream.lock'), lockText());
		await expect(upstreamList('resources/printers', { root })).rejects.toThrow(
			`is at ${v1.slice(0, 12)}`
		);
	});

	it('prefers --from over slicer/.upstream, and checks it the same way', async () => {
		const { root, pin } = fixture();
		const other = fixture();
		pin(other.v2);
		expect(
			(await upstreamFile('resources/printers/A.json', { root, from: other.up })).toString()
		).toBe('{"v":2}');
		pin('1'.repeat(40));
		await expect(
			upstreamFile('resources/printers/A.json', { root, from: other.up })
		).rejects.toThrow('but slicer/upstream.lock pins');
	});

	it('reads a plain directory only when asked to, with a warning', async () => {
		const { root } = fixture();
		const plain = tempDir();
		fs.mkdirSync(path.join(plain, 'resources', 'printers'), { recursive: true });
		fs.writeFileSync(path.join(plain, 'resources', 'printers', 'P.json'), 'plain');
		await expect(upstreamFile('resources/printers/P.json', { root, from: plain })).rejects.toThrow(
			'not a git checkout'
		);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(
			(
				await upstreamFile('resources/printers/P.json', { root, from: plain, allowUnpinned: true })
			).toString()
		).toBe('plain');
		expect(warn).toHaveBeenCalled();
	});
});
