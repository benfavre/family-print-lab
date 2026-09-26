// The one pinned Bambu Studio source for every generator (printer models, HMS texts, profiles):
// slicer/upstream.lock names the tag and commit; files come from a local checkout (slicer/.upstream,
// or --from <dir>) when there is one, else from GitHub at that commit, cached under
// app/resources/bambu/.cache/<commit>/ (git-ignored). Bumping the lock moves all derived data together.
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

/** Used when the lock does not exist yet (it always does in this repository). */
export const DEFAULT_LOCK: UpstreamLock = {
	name: 'BambuStudio',
	url: 'https://github.com/bambulab/BambuStudio.git',
	tag: 'v02.08.02.61',
	commit: '926a7192574bcb9b3a732e1ec59a46d79cb45466',
	queue: 0,
	queueHash: ''
};

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

/** Parses the key=value lock format (`#` starts a comment). */
export function parseLock(text: string): UpstreamLock {
	const values: Record<string, string> = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.replace(/#.*$/, '').trim();
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
	return file && fs.existsSync(file) ? parseLock(fs.readFileSync(file, 'utf8')) : DEFAULT_LOCK;
}

export interface UpstreamOptions {
	/** A Bambu Studio checkout to read instead of slicer/.upstream or GitHub. */
	from?: string;
	root?: string | null;
	/** Ignore the download cache. */
	refresh?: boolean;
	fetch?: typeof fetch;
}

function checkout(o: UpstreamOptions): string | null {
	if (o.from) return path.resolve(o.from);
	const root = o.root === undefined ? repoRoot() : o.root;
	const local = root && path.join(root, 'slicer', '.upstream');
	return local && fs.existsSync(path.join(local, 'resources')) ? local : null;
}

function safe(rel: string) {
	const clean = path.posix.normalize(rel.replace(/\\/g, '/'));
	if (clean.startsWith('..') || path.posix.isAbsolute(clean))
		throw new Error(`Not an upstream path: ${rel}`);
	return clean;
}

/** One file of the pinned Bambu Studio source, e.g. "resources/printers/C12.json". */
export async function upstreamFile(rel: string, o: UpstreamOptions = {}): Promise<Buffer> {
	const file = safe(rel);
	const dir = checkout(o);
	if (dir) return fs.readFileSync(path.join(dir, file));
	const root = o.root === undefined ? repoRoot() : o.root;
	const lock = readUpstreamLock(root);
	const cache = root && path.join(root, 'app', 'resources', 'bambu', '.cache', lock.commit, file);
	if (cache && !o.refresh && fs.existsSync(cache)) return fs.readFileSync(cache);
	const url = `https://raw.githubusercontent.com/bambulab/BambuStudio/${lock.commit}/${file}`;
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
	const dir = checkout(o);
	if (dir) return fs.readdirSync(path.join(dir, dirRel)).sort();
	const lock = readUpstreamLock(o.root === undefined ? repoRoot() : o.root);
	const url = `https://api.github.com/repos/bambulab/BambuStudio/contents/${dirRel}?ref=${lock.commit}`;
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
