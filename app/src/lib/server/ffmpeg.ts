// Where the system ffmpeg is, for every package that uses it (camera, AI checks, kids' photos, model
// pictures, pictures for the phone). FFMPEG_PATH (documented in .env.example) wins; FFMPEG_BIN is its
// older name, still read. Otherwise the usual places, then PATH. Null when there is none.
import fs from 'node:fs';
import path from 'node:path';

const USUAL = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'];

function runnable(file: string) {
	try {
		fs.accessSync(file, fs.constants.X_OK);
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

export function findFfmpeg(env: Record<string, string | undefined> = process.env): string | null {
	const set = env.FFMPEG_PATH || env.FFMPEG_BIN;
	if (set) return runnable(set) ? set : null;
	const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
	const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
	return [...USUAL, ...dirs.map((dir) => path.join(dir, name))].find(runnable) ?? null;
}
