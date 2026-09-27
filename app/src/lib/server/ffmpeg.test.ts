import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findFfmpeg } from './ffmpeg';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpl-ffmpeg-'));
const fake = path.join(dir, 'ffmpeg');
fs.writeFileSync(fake, '#!/bin/sh\n', { mode: 0o755 });
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('findFfmpeg', () => {
	it('takes FFMPEG_PATH first, then the older FFMPEG_BIN', () => {
		expect(findFfmpeg({ FFMPEG_PATH: fake, FFMPEG_BIN: '/nope' })).toBe(fake);
		expect(findFfmpeg({ FFMPEG_BIN: fake })).toBe(fake);
	});

	it('is null when the set path is not there, rather than guessing another one', () => {
		expect(findFfmpeg({ FFMPEG_PATH: path.join(dir, 'missing') })).toBeNull();
	});

	it('looks in PATH after the usual places', () => {
		const found = findFfmpeg({ PATH: dir });
		const usual = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'];
		expect(found === fake || usual.includes(found!)).toBe(true);
		if (!usual.some((p) => fs.existsSync(p))) expect(found).toBe(fake);
	});
});
