// The one pinned Bambu Studio source for every generator (printer models, HMS texts, profiles):
// slicer/upstream.lock names the tag and commit and is the only place they are written. Files come
// from a local git checkout (slicer/.upstream, or --from <dir>) read at exactly that commit, else from
// GitHub at that commit, cached under slicer/.build/upstream-cache/<commit>/ (git-ignored, and outside
// app/resources so it never ships in the desktop bundle). Bumping the lock moves all derived data together.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface UpstreamLock {
	name: string;
	url: string;
	tag: string;
	commit: string;
	/** Patch-queue version (bumped by `upstream.sh export`). */
	queue: number;
	/** sha256 over the series file and patches; empty when there are none. */
	queueHash: string;
}

/** Walks up from `from` to the repository root (the directory holding slicer/upstream.lock). */
export function repoRoot(from = process.cwd()): string | null {
	let dir = path.resolve(from);
	for (;;) {
		if (fs.existsSync(path.join(dir, 'slicer', 'upstream.lock'))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * Parses the key=value lock format. `#` starts a comment at the start of a line or after whitespace
 * (the same rule as slicer/scripts/upstream.sh), so a URL fragment such as `repo.git#main` survives.
 */
export function parseLock(text: string): UpstreamLock {
	const values: Record<string, string> = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.replace(/(^|\s)#.*$/, '').trim();
		const m = line.match(/^([a-z_]+)\s*=\s*(.*)$/);
		if (m) values[m[1]] = m[2].trim();
	}
	for (const key of ['name', 'url', 'tag', 'commit'])
		if (!values[key]) throw new Error(`slicer/upstream.lock is missing "${key}".`);
	if (!/^[0-9a-f]{40}$/.test(values.commit))
		throw new Error('slicer/upstream.lock: commit must be a full 40-character SHA.');
	return {
		name: values.name,
		url: values.url,
		tag: values.tag,
		commit: values.commit,
		queue: Number(values.queue ?? 0) || 0,
		queueHash: values.queue_hash ?? ''
	};
}

export function readUpstreamLock(root = repoRoot()): UpstreamLock {
	const file = root && path.join(root, 'slicer', 'upstream.lock');
	if (!file || !fs.existsSync(file))
		throw new Error(
			'slicer/upstream.lock not found: run this inside the Family Print Lab repository.'
		);
	return parseLock(fs.readFileSync(file, 'utf8'));
}

/** owner/repo of the lock's GitHub URL; the download fallback only knows GitHub. */
export function githubRepo(url: string): { owner: string; repo: string } {
	const m = url.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
	if (!m)
		throw new Error(
			`slicer/upstream.lock url ${url} is not a GitHub repository: use a local checkout (slicer/scripts/upstream.sh fetch) instead.`
		);
	return { owner: m[1], repo: m[2] };
}

export interface UpstreamOptions {
	/** A Bambu Studio checkout to read instead of slicer/.upstream or GitHub. */
	from?: string;
	root?: string | null;
	/** Ignore the download cache. */
	refresh?: boolean;
	/** Read a --from directory that is not a git checkout (its version cannot be checked). */
	allowUnpinned?: boolean;
	fetch?: typeof fetch;
}

type Source =
	| { kind: 'git'; dir: string; commit: string }
	| { kind: 'dir'; dir: string }
	| { kind: 'github'; lock: UpstreamLock; root: string | null };

const git = (dir: string, args: string[]) =>
	execFileSync('git', ['-C', dir, ...args], {
		stdio: ['ignore', 'pipe', 'pipe'],
		maxBuffer: 256 * 1024 * 1024
	});

function isGitCheckout(dir: string) {
	try {
		return git(dir, ['rev-parse', '--show-toplevel']).toString().trim() === fs.realpathSync(dir);
	} catch {
		return false;
	}
}

function hasCommit(dir: string, commit: string) {
	try {
		git(dir, ['cat-file', '-e', `${commit}^{commit}`]);
		return true;
	} catch {
		return false;
	}
}

/** What a checkout is at: printlab-base (upstream.sh's tag under the patch queue), else HEAD. */
function checkoutCommit(dir: string) {
	for (const ref of ['printlab-base^{commit}', 'HEAD'])
		try {
			return git(dir, ['rev-parse', '--verify', '--quiet', ref]).toString().trim();
		} catch {
			// next
		}
	return 'nothing';
}

/**
 * Where the pinned files come from. A local checkout is read at the locked commit, never its working
 * tree, so a stale slicer/.upstream (after the lock moved) or a checkout mid-rebase cannot label one
 * Bambu Studio version's data as another's.
 */
function source(o: UpstreamOptions): Source {
	const root = o.root === undefined ? repoRoot() : o.root;
	const lock = readUpstreamLock(root);
	const local = root && path.join(root, 'slicer', '.upstream');
	const dir = o.from
		? path.resolve(o.from)
		: local && fs.existsSync(path.join(local, '.git'))
			? local
			: null;
	if (!dir) return { kind: 'github', lock, root };
	const label = o.from ? dir : 'slicer/.upstream';
	if (isGitCheckout(dir)) {
		if (hasCommit(dir, lock.commit)) return { kind: 'git', dir, commit: lock.commit };
		throw new Error(
			`${label} is at ${checkoutCommit(dir).slice(0, 12)}, but slicer/upstream.lock pins ${lock.tag} (${lock.commit.slice(0, 12)}): run slicer/scripts/upstream.sh fetch.`
		);
	}
	if (!o.allowUnpinned)
		throw new Error(
			`${label} is not a git checkout, so its Bambu Studio version cannot be checked against slicer/upstream.lock (${lock.tag}). Pass --allow-unpinned to use it anyway.`
		);
	console.warn(
		`Warning: reading ${label} without checking its version; the output will claim ${lock.tag}.`
	);
	return { kind: 'dir', dir };
}

function safe(rel: string) {
	const clean = path.posix.normalize(rel.replace(/\\/g, '/'));
	if (clean.startsWith('..') || path.posix.isAbsolute(clean))
		throw new Error(`Not an upstream path: ${rel}`);
	return clean.replace(/\/$/, '');
}

/** One file of the pinned Bambu Studio source, e.g. "resources/printers/C12.json". */
export async function upstreamFile(rel: string, o: UpstreamOptions = {}): Promise<Buffer> {
	const file = safe(rel);
	const src = source(o);
	if (src.kind === 'git') return git(src.dir, ['show', `${src.commit}:${file}`]);
	if (src.kind === 'dir') return fs.readFileSync(path.join(src.dir, file));
	const { lock, root } = src;
	const cache = root && path.join(root, 'slicer', '.build', 'upstream-cache', lock.commit, file);
	if (cache && !o.refresh && fs.existsSync(cache)) return fs.readFileSync(cache);
	const { owner, repo } = githubRepo(lock.url);
	const url = `https://raw.githubusercontent.com/${owner}/${repo}/${lock.commit}/${file}`;
	const res = await (o.fetch ?? fetch)(url, { headers: { 'user-agent': 'family-print-lab' } });
	if (!res.ok) throw new Error(`Could not download ${url}: HTTP ${res.status}`);
	const data = Buffer.from(await res.arrayBuffer());
	if (cache) {
		fs.mkdirSync(path.dirname(cache), { recursive: true });
		fs.writeFileSync(cache, data);
	}
	return data;
}

/** File names in one upstream directory (GitHub's contents API when there is no checkout). */
export async function upstreamList(rel: string, o: UpstreamOptions = {}): Promise<string[]> {
	const dirRel = safe(rel);
	const src = source(o);
	if (src.kind === 'git')
		return git(src.dir, ['ls-tree', `${src.commit}:${dirRel}`])
			.toString()
			.split('\n')
			.map((line) => line.match(/^\d+ blob [0-9a-f]+\t(.+)$/)?.[1])
			.filter((name): name is string => !!name)
			.sort();
	if (src.kind === 'dir')
		return fs
			.readdirSync(path.join(src.dir, dirRel), { withFileTypes: true })
			.filter((e) => e.isFile())
			.map((e) => e.name)
			.sort();
	const { owner, repo } = githubRepo(src.lock.url);
	const url = `https://api.github.com/repos/${owner}/${repo}/contents/${dirRel}?ref=${src.lock.commit}`;
	const res = await (o.fetch ?? fetch)(url, {
		headers: { 'user-agent': 'family-print-lab', accept: 'application/vnd.github+json' }
	});
	if (!res.ok) throw new Error(`Could not list ${dirRel} upstream: HTTP ${res.status}`);
	const entries = (await res.json()) as { name: string; type: string }[];
	return entries
		.filter((e) => e.type === 'file')
		.map((e) => e.name)
		.sort();
}
