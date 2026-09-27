import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { locateProfiles } from './locate';
import type { SlicerHost } from '../slicer/locate';

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const temp = () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fpl-profiles-'));
	dirs.push(d);
	return d;
};
const vendorIn = (dir: string, stamp?: string) => {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'BBL.json'), '{}');
	if (stamp) fs.writeFileSync(path.join(dir, 'upstream.json'), JSON.stringify({ tag: stamp }));
};
/** A machine with no slicer installed. */
const bare: SlicerHost = {
	platform: 'linux',
	arch: 'x64',
	home: '/nonexistent',
	isFile: () => false,
	isExecutable: () => false,
	isDir: () => false,
	readdir: () => []
};

describe('locateProfiles', () => {
	it('prefers PRINTLAB_PROFILES_DIR over the fetched folder, and reads the fetched tag', () => {
		const cwd = temp();
		vendorIn(path.join(cwd, 'resources', 'bambu', 'profiles'), 'v02.08.02.61');
		expect(locateProfiles({}, cwd, bare)).toEqual({
			dir: path.join(cwd, 'resources', 'bambu', 'profiles'),
			source: 'app',
			tag: 'v02.08.02.61'
		});
		const custom = temp();
		vendorIn(path.join(custom, 'profiles'));
		expect(locateProfiles({ PRINTLAB_PROFILES_DIR: custom }, cwd, bare)).toEqual({
			dir: path.join(custom, 'profiles'),
			source: 'env',
			tag: 'unknown'
		});
	});

	it('finds nothing when no folder has BBL.json', () => {
		expect(locateProfiles({ PRINTLAB_PROFILES_DIR: temp() }, temp(), bare)).toBe(null);
	});
});
