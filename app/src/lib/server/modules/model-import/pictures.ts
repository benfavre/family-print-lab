// Model pictures become project sketches (PNG, in the database, so backups include them and the project
// page shows them). JPEG, WebP and GIF pictures are converted with the system ffmpeg, scaled to at most
// 1600 px wide; without ffmpeg only PNG pictures are kept.
import { spawn } from 'node:child_process';

const PNG = '89504e470d0a1a0a';
const SKETCH_MAX = 4_000_000;

export const isPng = (b: Buffer) => b.subarray(0, 8).toString('hex') === PNG;

/** PNG dimensions from its header (0 when it is not a PNG). */
export function pngSize(b: Buffer) {
	if (!isPng(b) || b.length < 24) return { width: 0, height: 0 };
	return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/**
 * The ffmpeg demuxer for a picture, from its first bytes (null when it is not JPEG, PNG, WebP or GIF).
 * ffmpeg is never left to guess: a file that only claims to be a picture (an HLS playlist, a concat
 * list) could otherwise make it open other files or addresses.
 */
export function pictureDemuxer(b: Buffer) {
	if (isPng(b)) return 'png_pipe';
	if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg_pipe';
	if (
		b.length > 12 &&
		b.toString('latin1', 0, 4) === 'RIFF' &&
		b.toString('latin1', 8, 12) === 'WEBP'
	)
		return 'webp_pipe';
	if (/^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'gif_pipe';
	return null;
}

/** Converts a picture to a sketch-sized PNG, or null when it cannot. */
export async function toPng(image: Buffer, ffmpeg: string | null): Promise<Buffer | null> {
	const { width, height } = pngSize(image);
	if (width && width <= 1600 && height <= 8000 && image.length <= SKETCH_MAX) return image;
	const demuxer = pictureDemuxer(image);
	if (!ffmpeg || !demuxer) return null;
	const png = await new Promise<Buffer | null>((resolve) => {
		const child = spawn(
			ffmpeg,
			[
				'-hide_banner',
				'-loglevel',
				'error',
				'-protocol_whitelist',
				'pipe',
				'-f',
				demuxer,
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
