// The rough check: no AI, nothing leaves the computer. ffmpeg turns each camera picture into a small
// greyscale image (160×120), and we compare how busy it looks (edge density, per 20×20 cell) with the
// picture taken after the first layer and with the last picture that looked fine. Spaghetti shows up
// as many cells that suddenly fill with edges; a part that moved shows up as several cells whose
// brightness changed a lot without that (the toolhead alone moves two or three). It knows nothing
// about prints, so it is labelled a rough check everywhere and never claims more than 90 % confidence.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { VisionVerdict } from '$lib/shared/vision';

export const GREY_W = 160;
export const GREY_H = 120;
const CELL = 20;
const COLS = GREY_W / CELL;
const ROWS = GREY_H / CELL;
/** A pixel is an edge when the brightness steps by more than this to its right or lower neighbour. */
const EDGE_STEP = 28;
/** A cell "filled with edges" when its edge density rose by this much over both pictures. */
const CELL_RISE_REF = 0.22;
const CELL_RISE_PREV = 0.16;
/** A cell's mean brightness changed by more than this (0–255)… */
const CELL_CHANGE = 20;
/** …in at least this many cells: "something big moved". */
const MOVED_CELLS = 5;

/** A greyscale picture, GREY_W × GREY_H bytes. */
export interface Frame {
	grey: Uint8Array;
	/** Edge density per cell, row by row (COLS × ROWS). */
	cells: Float32Array;
	/** Mean brightness per cell. */
	light: Float32Array;
	/** Edge density of the whole picture. */
	edges: number;
}

export function analyse(grey: Uint8Array): Frame {
	if (grey.length !== GREY_W * GREY_H) throw new Error('Wrong picture size.');
	const counts = new Float32Array(COLS * ROWS);
	const light = new Float32Array(COLS * ROWS);
	let total = 0;
	for (let y = 0; y < GREY_H; y++)
		for (let x = 0; x < GREY_W; x++) {
			const i = y * GREY_W + x;
			const cell = Math.floor(y / CELL) * COLS + Math.floor(x / CELL);
			light[cell] += grey[i] / (CELL * CELL);
			if (x === GREY_W - 1 || y === GREY_H - 1) continue;
			const g = Math.abs(grey[i] - grey[i + 1]) + Math.abs(grey[i] - grey[i + GREY_W]);
			if (g > EDGE_STEP) {
				counts[cell]++;
				total++;
			}
		}
	const cells = counts.map((c) => c / (CELL * CELL));
	return { grey, cells, light, edges: total / (GREY_W * GREY_H) };
}

export interface HeuristicResult {
	verdict: VisionVerdict;
	confidence: number;
	reason: string;
	/** Cells that suddenly filled with edges. */
	cells: number;
	/** Cells whose brightness changed a lot since the last good picture. */
	moved: number;
}

/**
 * Judges `current` against the first-layer `reference` and the last picture that looked fine
 * (`previous`, or the reference when there is none yet).
 */
export function judge(reference: Frame, previous: Frame | null, current: Frame): HeuristicResult {
	const prev = previous ?? reference;
	let cells = 0;
	for (let i = 0; i < current.cells.length; i++)
		if (
			current.cells[i] - reference.cells[i] > CELL_RISE_REF &&
			current.cells[i] - prev.cells[i] > CELL_RISE_PREV
		)
			cells++;
	let moved = 0;
	for (let i = 0; i < current.light.length; i++)
		if (Math.abs(current.light[i] - prev.light[i]) > CELL_CHANGE) moved++;
	const round = (n: number) => Math.round(n * 100) / 100;
	if (cells >= 2) {
		const confidence = round(Math.min(0.9, 0.5 + 0.06 * cells));
		return {
			verdict: 'spaghetti',
			confidence,
			reason: `A part of the picture suddenly looks tangled (${cells} of ${COLS * ROWS} areas). Rough check: have a look.`,
			cells,
			moved
		};
	}
	if (moved >= MOVED_CELLS)
		return {
			verdict: 'unsure',
			confidence: round(Math.min(0.6, 0.3 + 0.03 * moved)),
			reason:
				'The picture changed a lot since the last check (a moved part, the light or the door?). Rough check: have a look.',
			cells,
			moved
		};
	return {
		verdict: 'ok',
		confidence: 0.6,
		reason: 'Nothing changed suddenly since the first layer. Rough check only.',
		cells,
		moved
	};
}

/** ffmpeg's arguments: one JPEG on stdin, 160×120 8-bit greyscale on stdout. */
export function greyArgs(): string[] {
	return [
		'-hide_banner',
		'-loglevel',
		'error',
		'-f',
		'image2pipe',
		'-c:v',
		'mjpeg',
		'-i',
		'pipe:0',
		'-frames:v',
		'1',
		'-f',
		'rawvideo',
		'-pix_fmt',
		'gray',
		'-s',
		`${GREY_W}x${GREY_H}`,
		'pipe:1'
	];
}

/** Decodes a JPEG to a greyscale Frame with ffmpeg. */
export function decodeGrey(ffmpeg: string, jpeg: Buffer, timeoutMs = 10_000): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		const child = spawn(ffmpeg, greyArgs(), { stdio: ['pipe', 'pipe', 'pipe'] });
		const out: Buffer[] = [];
		let err = '';
		const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
		child.stdout.on('data', (d: Buffer) => out.push(d));
		child.stderr.on('data', (d: Buffer) => (err += d.toString()));
		child.on('error', (e) => {
			clearTimeout(timer);
			reject(new Error(`Could not start ffmpeg: ${e.message}`));
		});
		child.on('close', () => {
			clearTimeout(timer);
			const data = Buffer.concat(out);
			if (data.length !== GREY_W * GREY_H)
				return reject(
					new Error(
						`ffmpeg could not read the picture${err ? `: ${err.trim().slice(0, 200)}` : '.'}`
					)
				);
			resolve(new Uint8Array(data));
		});
		child.stdin.on('error', () => {});
		child.stdin.end(jpeg);
	});
}

/** ffmpeg: FFMPEG_PATH, else the usual places; null when there is none. */
export function findFfmpeg(env: Record<string, string | undefined> = process.env): string | null {
	const candidates = env.FFMPEG_PATH
		? [env.FFMPEG_PATH]
		: ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'];
	for (const path of candidates) {
		try {
			fs.accessSync(path, fs.constants.X_OK);
			return path;
		} catch {
			/* next */
		}
	}
	return null;
}
