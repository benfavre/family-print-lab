// Gallery photos: WebP or JPEG, at most 400 KB. Uploads are shrunk in the browser; camera snapshots
// that are larger are scaled down here with the system ffmpeg (no image library needed).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { AppError } from '../../validation';

export const MAX_PHOTO_BYTES = 400 * 1024;

export type PhotoMime = 'image/webp' | 'image/jpeg';

/** The image type from its first bytes, or null when it is neither WebP nor JPEG. */
export function sniffPhoto(buf: Buffer): PhotoMime | null {
	if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
	if (
		buf.length > 12 &&
		buf.toString('latin1', 0, 4) === 'RIFF' &&
		buf.toString('latin1', 8, 12) === 'WEBP'
	)
		return 'image/webp';
	return null;
}

/** Reads an uploaded photo sent as a data URL or plain base64. */
export function decodePhoto(input: string): { image: Buffer; mime: PhotoMime } {
	const base64 = input.replace(/^data:image\/(webp|jpeg);base64,/, '');
	if (!/^[A-Za-z0-9+/=\s]*$/.test(base64)) throw new AppError(400, 'That photo could not be read.');
	const image = Buffer.from(base64, 'base64');
	const mime = sniffPhoto(image);
	if (!mime) throw new AppError(400, 'Photos must be JPEG or WebP.');
	if (image.length > MAX_PHOTO_BYTES)
		throw new AppError(413, 'That photo is too large (400 KB at most).');
	return { image, mime };
}

export function ffmpegPath(env: Record<string, string | undefined> = process.env) {
	if (env.FFMPEG_BIN) return env.FFMPEG_BIN;
	return fs.existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : 'ffmpeg';
}

/** Re-encodes a JPEG at most `width` pixels wide. */
function scaleJpeg(bin: string, input: Buffer, width: number, signal?: AbortSignal) {
	return new Promise<Buffer>((resolve, reject) => {
		const child = spawn(
			bin,
			[
				...['-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-i', 'pipe:0'],
				...['-vf', `scale='min(${width},iw)':-2`, '-q:v', '5', '-frames:v', '1'],
				...['-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1']
			],
			{ stdio: ['pipe', 'pipe', 'pipe'], signal }
		);
		const out: Buffer[] = [];
		let err = '';
		child.stdout.on('data', (d: Buffer) => out.push(d));
		child.stderr.on('data', (d: Buffer) => (err += d.toString().slice(0, 500)));
		child.on('error', reject);
		child.on('close', (code) =>
			code === 0 && out.length
				? resolve(Buffer.concat(out))
				: reject(new Error(err.trim() || `ffmpeg exited with ${code}`))
		);
		child.stdin.on('error', () => {});
		child.stdin.end(input);
	});
}

/** A camera snapshot (JPEG) that fits the gallery: as it is when small enough, else scaled down. */
export async function fitSnapshot(
	jpeg: Buffer,
	o: { bin?: string; signal?: AbortSignal } = {}
): Promise<Buffer> {
	if (sniffPhoto(jpeg) !== 'image/jpeg') throw new Error('The camera did not send a JPEG.');
	if (jpeg.length <= MAX_PHOTO_BYTES) return jpeg;
	for (const width of [1280, 960, 640]) {
		const small = await scaleJpeg(o.bin ?? ffmpegPath(), jpeg, width, o.signal);
		if (small.length <= MAX_PHOTO_BYTES) return small;
	}
	throw new Error('The snapshot stays too large for the gallery.');
}
