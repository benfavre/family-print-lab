// Model pictures become project sketches (PNG, in the database, so backups include them and the project
// page shows them). JPEG, WebP and GIF pictures are converted with the system ffmpeg, scaled to at most
// 1600 px wide; without ffmpeg only PNG pictures are kept.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { findBin } from '$lib/server/ai/providers';

const PNG = '89504e470d0a1a0a';
const SKETCH_MAX = 4_000_000;

export const isPng = (b: Buffer) => b.subarray(0, 8).toString('hex') === PNG;

export function findFfmpeg(override?: string) {
	if (override) return fs.existsSync(override) ? override : null;
	return fs.existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : findBin('ffmpeg');
}

/** PNG dimensions from its header (0 when it is not a PNG). */
export function pngSize(b: Buffer) {
	if (!isPng(b) || b.length < 24) return { width: 0, height: 0 };
	return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** Converts a picture to a sketch-sized PNG, or null when it cannot. */
export async function toPng(image: Buffer, ffmpeg: string | null): Promise<Buffer | null> {
	const { width, height } = pngSize(image);
	if (width && width <= 1600 && height <= 8000 && image.length <= SKETCH_MAX) return image;
	if (!ffmpeg) return null;
	const png = await new Promise<Buffer | null>((resolve) => {
		const child = spawn(
			ffmpeg,
			[
				'-hide_banner',
				'-loglevel',
				'error',
				'-i',
				'pipe:0',
				'-frames:v',
				'1',
				'-vf',
				"scale='min(1600,iw)':-2",
				'-f',
				'image2pipe',
				'-vcodec',
				'png',
				'pipe:1'
			],
			{ stdio: ['pipe', 'pipe', 'ignore'] }
		);
		const out: Buffer[] = [];
		const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
		child.stdout.on('data', (c: Buffer) => out.push(c));
		child.on('error', () => resolve(null));
		child.on('close', (code) => {
			clearTimeout(timer);
			resolve(code === 0 ? Buffer.concat(out) : null);
		});
		child.stdin.on('error', () => {});
		child.stdin.end(image);
	});
	return png && isPng(png) && png.length <= SKETCH_MAX ? png : null;
}
