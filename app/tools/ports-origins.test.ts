// slicer/ports/ORIGINS.md is what `upstream.sh ports` reads to flag ported code whose upstream source
// changed, so a port without a row is never reviewed on an update. Every source file whose header
// comment cites a Bambu Studio path (src/libslic3r/…, src/slic3r/…) must have a row for that path, and
// every file with a row an `origin:` line naming each of its paths.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ORIGINS = fs.readFileSync(path.join(ROOT, 'slicer/ports/ORIGINS.md'), 'utf8');
const ROW = /^\|\s*`([^`]+)`\s*\|\s*(\w+)\s*\|\s*`([^`]+)`\s*\|\s*`([0-9a-f]{7,40})`\s*\|$/gm;
const rows = [...ORIGINS.matchAll(ROW)].map((m) => ({ file: m[1], repo: m[2], upstream: m[3] }));
const CITED = /src\/(?:libslic3r|slic3r)\/[\w/.+-]+?\.(?:cpp|hpp|h)\b/g;
// Generated data and test fixtures are regenerated from the pin, not ported (ORIGINS.md says so).
const SKIP = /(\.generated\.ts|\.test\.ts|\/__fixtures__\/)/;

/** The comment block a file starts with. */
function header(file: string) {
	const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
	const out: string[] = [];
	for (const line of lines) {
		const l = line.trim();
		if (l.startsWith('//') || l.startsWith('/*') || l.startsWith('*')) out.push(l);
		else if (l || out.length) break;
	}
	return out.join('\n');
}

const sources = execFileSync('git', ['ls-files', 'app/src', 'app/tools', 'slicer/engine/src'], {
	cwd: ROOT,
	encoding: 'utf8'
})
	.split('\n')
	.filter((f) => /\.(ts|cpp|hpp|h)$/.test(f) && !SKIP.test(f));

describe('slicer/ports/ORIGINS.md', () => {
	it('parses', () => expect(rows.length).toBeGreaterThan(20));

	it('has a row for every Bambu Studio path a source file header cites', () => {
		const missing: string[] = [];
		for (const file of sources)
			for (const upstream of new Set(header(file).match(CITED) ?? []))
				if (!rows.some((r) => r.file === file && r.upstream === upstream))
					missing.push(`${file} → ${upstream}`);
		expect(missing).toEqual([]);
	});

	it('names only files that exist, each with an origin line for its code files', () => {
		const problems: string[] = [];
		for (const r of rows) {
			if (!fs.existsSync(path.join(ROOT, r.file))) problems.push(`${r.file}: not found`);
			else if (/\.(ts|cpp|hpp|h)$/.test(r.file)) {
				const h = header(r.file);
				if (!h.includes(`origin: ${r.repo}`)) problems.push(`${r.file}: no "origin: ${r.repo}"`);
				else if (!h.includes(r.upstream)) problems.push(`${r.file}: origin misses ${r.upstream}`);
			}
		}
		expect(problems).toEqual([]);
	});
});
