// Camera pictures for the phone: at most 1280 px wide and small enough that the sealed picture, in
// base64, stays well under 1 MiB per WebSocket message. (Cloudflare accepts up to 32 MiB per received
// WebSocket message, https://developers.cloudflare.com/durable-objects/platform/limits/ ; we keep
// far below it so a phone on a slow connection still gets pictures quickly.)
import { spawn } from 'node:child_process';
import { AppError } from '../validation';

export const MAX_WIDTH = 1280;
/** 512 KB of JPEG is about 700 KB of base64. */
export const MAX_JPEG = 512 * 1024;

/** Width and height from a JPEG's start-of-frame marker, or null when there is none. */
export function jpegSize(jpeg: Buffer): { width: number; height: number } | null {
	if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
	let at = 2;
	while (at + 9 < jpeg.length) {
		if (jpeg[at] !== 0xff) return null;
		const marker = jpeg[at + 1];
		if (marker === 0xff) {
			at++;
			continue;
		}
		const length = jpeg.readUInt16BE(at + 2);
		// SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
		if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
			return { height: jpeg.readUInt16BE(at + 5), width: jpeg.readUInt16BE(at + 7) };
		at += 2 + length;
	}
	return null;
}

/**
 * The picture as it may go to the phone: unchanged when it already fits, else scaled down and
 * compressed again with ffmpeg (JPEG quality well below 70). Throws when it cannot be made to fit.
 */
export async function fitForPhone(jpeg: Buffer, ffmpeg: string | null): Promise<Buffer> {
	const size = jpegSize(jpeg);
	if (!size) throw new AppError(502, 'The camera did not send a picture.');
	if (size.width <= MAX_WIDTH && jpeg.length <= MAX_JPEG) return jpeg;
	if (!ffmpeg)
		throw new AppError(502, 'This picture is too big to send, and ffmpeg is not installed.');
	const smaller = await run(ffmpeg, jpeg, [
		'-hide_banner',
		'-loglevel',
		'error',
		'-f',
		'image2pipe',
		'-c:v',
		'mjpeg',
		'-i',
		'pipe:0',
		'-vf',
		`scale='min(${MAX_WIDTH},iw)':-2`,
		'-q:v',
		'10',
		'-frames:v',
		'1',
		'-f',
		'image2',
		'-c:v',
		'mjpeg',
		'pipe:1'
	]);
	if (smaller.length > MAX_JPEG) throw new AppError(502, 'This picture is too big to send.');
	return smaller;
}

function run(bin: string, input: Buffer, args: string[]) {
	return new Promise<Buffer>((resolve, reject) => {
		const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'ignore'] });
		const out: Buffer[] = [];
		const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
		child.stdout.on('data', (c: Buffer) => out.push(c));
		child.on('error', reject);
		child.on('close', (code) => {
			clearTimeout(timer);
			if (code === 0 && out.length) resolve(Buffer.concat(out));
			else reject(new AppError(502, 'Could not make the picture smaller.'));
		});
		child.stdin.on('error', () => {});
		child.stdin.end(input);
	});
}
