// Timelapses and other files on the printer's storage, over the printer's FTPS file service (the
// /timelapse folder is where ha-bambulab pybambu/media_sources.py Ftps990MediaSource looks for them).
// Newer models may keep timelapses on internal storage that only the port-6000 file tunnel reaches
// (OpenBambuAPI lan-file-tunnel.md; ha-bambulab Tcp6000MediaSource); the app does not speak that yet
// and says so. At most two file connections per printer at a time: printers are small computers.
import type { Readable } from 'node:stream';
import type { BambuPrinter } from '$lib/server/printer/bambu';
import {
	downloadFile,
	FtpNotFound,
	listFiles,
	safeFtpPath,
	type FtpEntry,
	type FtpOptions
} from '$lib/server/printer/ftp';
import { printerTlsOptions, verifyPrinterCert } from '$lib/server/printer/tls';
import { AppError } from '$lib/server/validation';
import { TIMELAPSE_DIR, mediaKind, type MediaEntry, type MediaListing } from '$lib/shared/camera';

export const MEDIA_NOTES = {
	unreachable: 'This printer keeps timelapses where the app cannot reach them yet.',
	none: 'No timelapses yet. Turn on timelapse before a print and it appears here when the print ends.',
	empty: 'This folder is empty.'
} as const;

/** The printer's file service with the same trust rules as uploads (never trust on first use here). */
export function ftpOptionsFor(p: BambuPrinter): FtpOptions {
	const { host, accessCode, useTls = true, serial, simulated, tlsPin, ftpPort } = p.config;
	const verifyTls = useTls && !simulated;
	return {
		host,
		password: accessCode,
		useTls,
		port: ftpPort ?? (useTls ? 990 : 21),
		timeoutMs: 15_000,
		tls: verifyTls
			? {
					options: printerTlsOptions(serial),
					verify: (socket) => {
						const r = verifyPrinterCert(socket, { serial, pin: tlsPin ?? null, mayPin: false });
						return r.ok ? null : r.error;
					}
				}
			: undefined
	};
}

/** Two file connections per printer at a time; the rest wait their turn. */
export function limiter(max = 2) {
	const running = new Map<string, number>();
	const queue = new Map<string, (() => void)[]>();
	return async function acquire(key: string): Promise<() => void> {
		if ((running.get(key) ?? 0) >= max)
			await new Promise<void>((resolve) => queue.set(key, [...(queue.get(key) ?? []), resolve]));
		running.set(key, (running.get(key) ?? 0) + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			running.set(key, (running.get(key) ?? 1) - 1);
			const next = queue.get(key)?.shift();
			next?.();
		};
	};
}

export function joinPath(dir: string, name: string) {
	return `${dir.replace(/\/+$/, '')}/${name}`;
}

const base = (name: string) => name.replace(/\.[^.]+$/, '').toLowerCase();

/**
 * Turns a folder listing into media entries: folders first, then newest first; a picture with the
 * same name as a video (next to it or in a "thumbnail" subfolder) becomes its thumbnail.
 */
export function toMedia(dir: string, list: FtpEntry[], thumbs: FtpEntry[] = []): MediaEntry[] {
	const pictures = new Map<string, string>();
	for (const t of thumbs)
		if (t.type === 'file' && mediaKind(t.name, 'file') === 'image')
			pictures.set(base(t.name), joinPath(joinPath(dir, 'thumbnail'), t.name));
	for (const e of list)
		if (e.type === 'file' && mediaKind(e.name, 'file') === 'image')
			pictures.set(base(e.name), joinPath(dir, e.name));
	return list
		.map((e) => {
			const kind = mediaKind(e.name, e.type);
			return {
				name: e.name,
				path: joinPath(dir, e.name),
				type: e.type,
				size: e.size,
				modified: e.modified,
				kind,
				thumbnail:
					kind === 'video' || kind === 'print' ? (pictures.get(base(e.name)) ?? null) : null
			};
		})
		.sort(
			(a, b) =>
				Number(b.type === 'dir') - Number(a.type === 'dir') ||
				(b.modified ?? '').localeCompare(a.modified ?? '') ||
				a.name.localeCompare(b.name)
		);
}

export function createMedia(o: {
	list?: typeof listFiles;
	download?: typeof downloadFile;
	maxPerPrinter?: number;
}) {
	const list = o.list ?? listFiles;
	const download = o.download ?? downloadFile;
	const acquire = limiter(o.maxPerPrinter ?? 2);

	async function listDir(p: BambuPrinter, dir: string, signal?: AbortSignal) {
		const release = await acquire(p.id);
		try {
			return await list(ftpOptionsFor(p), dir, signal);
		} finally {
			release();
		}
	}

	return {
		/** A folder on the printer, with a note when there is nothing to show. */
		async list(p: BambuPrinter, dir: string, signal?: AbortSignal): Promise<MediaListing> {
			const clean = dir.replace(/(.)\/+$/, '$1');
			if (!safeFtpPath(clean)) throw new AppError(400, 'That folder name is not allowed.');
			if (!p.connected) throw new AppError(409, 'The printer is not connected.');
			const timelapses = clean === TIMELAPSE_DIR;
			const nothing = p.model.camera === 'rtsps' ? MEDIA_NOTES.unreachable : MEDIA_NOTES.none;
			let entries: FtpEntry[];
			try {
				entries = await listDir(p, clean, signal);
			} catch (error) {
				if (!(error instanceof FtpNotFound)) throw new AppError(502, (error as Error).message);
				if (timelapses) return { dir: clean, entries: [], note: nothing };
				throw new AppError(404, 'That folder is not on the printer.');
			}
			// Some firmware keeps timelapse pictures in a "thumbnail" folder beside the videos.
			const thumbDir = entries.find((e) => e.type === 'dir' && e.name === 'thumbnail');
			const thumbs = thumbDir
				? await listDir(p, joinPath(clean, 'thumbnail'), signal).catch(() => [])
				: [];
			// In the timelapse view the thumbnail folder is shown through the videos, not as a folder.
			const shown = timelapses && thumbDir ? entries.filter((e) => e !== thumbDir) : entries;
			const media = toMedia(clean, shown, thumbs);
			const note = timelapses
				? media.some((m) => m.kind === 'video')
					? null
					: nothing
				: media.length
					? null
					: MEDIA_NOTES.empty;
			return { dir: clean, entries: media, note };
		},

		/**
		 * Streams one file. The path must name a file its folder lists (so nothing outside what the
		 * browser was shown can be fetched).
		 */
		async open(
			p: BambuPrinter,
			path: string,
			signal?: AbortSignal
		): Promise<{ stream: Readable; size: number | null; name: string }> {
			if (!safeFtpPath(path) || path.endsWith('/'))
				throw new AppError(400, 'That file name is not allowed.');
			if (!p.connected) throw new AppError(409, 'The printer is not connected.');
			const slash = path.lastIndexOf('/');
			const dir = path.slice(0, slash) || '/';
			const name = path.slice(slash + 1);
			let entries: FtpEntry[];
			try {
				entries = await listDir(p, dir, signal);
			} catch (error) {
				if (error instanceof FtpNotFound)
					throw new AppError(404, 'That file is not on the printer.');
				throw new AppError(502, (error as Error).message);
			}
			const entry = entries.find((e) => e.type === 'file' && e.name === name);
			if (!entry) throw new AppError(404, 'That file is not on the printer.');
			const release = await acquire(p.id);
			try {
				const stream = await download(ftpOptionsFor(p), path, undefined, signal);
				stream.once('close', release);
				return { stream, size: entry.size, name };
			} catch (error) {
				release();
				if (error instanceof FtpNotFound)
					throw new AppError(404, 'That file is not on the printer.');
				throw new AppError(502, (error as Error).message);
			}
		}
	};
}

export type Media = ReturnType<typeof createMedia>;
