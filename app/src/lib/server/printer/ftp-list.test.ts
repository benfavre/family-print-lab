// Listing folders and streaming files from the printer's storage (timelapses), against the simulator's
// file service: MLSD with the LIST fallback, the line parsers, path checks and TLS session reuse.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	downloadFile,
	FtpNotFound,
	listFiles,
	parseListLine,
	parseMlsdLine,
	safeFtpPath
} from './ftp';
import { createFtpServer } from './ftp-server';

function selfSigned() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'print-lab-cert-'));
	try {
		execFileSync(
			'openssl',
			[
				'req',
				'-x509',
				'-newkey',
				'rsa:2048',
				'-nodes',
				'-days',
				'1',
				'-subj',
				'/CN=SIM-X2D-0001',
				'-keyout',
				path.join(dir, 'key.pem'),
				'-out',
				path.join(dir, 'cert.pem')
			],
			{ stdio: 'ignore' }
		);
		return {
			key: fs.readFileSync(path.join(dir, 'key.pem')),
			cert: fs.readFileSync(path.join(dir, 'cert.pem'))
		};
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

const at = '2026-09-01T10:15:00.000Z';
function seeded(o: { noMlsd?: boolean; tls?: { key: Buffer; cert: Buffer } } = {}) {
	const server = createFtpServer({ accessCode: '12345678', ...o });
	const put = (name: string, data: Buffer) => server.files.set(name, { name, data, at });
	put('timelapse/video_2026-09-01_10-15-00.mp4', Buffer.alloc(300_000, 3));
	put('timelapse/thumbnail/video_2026-09-01_10-15-00.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
	put('model.gcode.3mf', Buffer.from('3mf'));
	return server;
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
	const parts: Buffer[] = [];
	for await (const chunk of stream) parts.push(chunk as Buffer);
	return Buffer.concat(parts);
}

describe('FTP listing lines', () => {
	it('reads MLSD facts', () => {
		expect(parseMlsdLine('type=file;size=1234;modify=20260901101500; video one.mp4')).toEqual({
			name: 'video one.mp4',
			type: 'file',
			size: 1234,
			modified: '2026-09-01T10:15:00.000Z'
		});
		expect(parseMlsdLine('type=dir;modify=20260901101500; thumbnail')).toMatchObject({
			name: 'thumbnail',
			type: 'dir',
			size: null
		});
		expect(parseMlsdLine('type=cdir; .')).toBeNull();
		expect(parseMlsdLine('garbage')).toBeNull();
	});

	it('reads Unix LIST lines, with and without a year', () => {
		const now = new Date('2026-09-27T12:00:00Z');
		expect(
			parseListLine('-rw-r--r--    1 root     root      1048576 Sep 01 10:15 video_1.mp4', now)
		).toEqual({
			name: 'video_1.mp4',
			type: 'file',
			size: 1048576,
			modified: '2026-09-01T10:15:00.000Z'
		});
		// December with a time, seen in September: last December.
		expect(parseListLine('-rw-r--r-- 1 root root 5 Dec 24 08:00 old.mp4', now)?.modified).toBe(
			'2025-12-24T08:00:00.000Z'
		);
		expect(parseListLine('-rw-r--r-- 1 root root 5 Mar 02  2024 older.avi', now)?.modified).toBe(
			'2024-03-02T00:00:00.000Z'
		);
		expect(parseListLine('drwxr-xr-x 2 root root 4096 Sep 01 10:15 thumbnail', now)).toMatchObject({
			name: 'thumbnail',
			type: 'dir',
			size: null
		});
		expect(parseListLine('lrwxrwxrwx 1 root root 4 Sep 01 10:15 link -> target', now)?.name).toBe(
			'link'
		);
		expect(parseListLine('total 12', now)).toBeNull();
	});
});

describe('FTP paths', () => {
	it('accepts absolute paths and refuses traversal and control characters', () => {
		expect(safeFtpPath('/timelapse')).toBe(true);
		expect(safeFtpPath('/timelapse/')).toBe(true);
		expect(safeFtpPath('/timelapse/video 1.mp4')).toBe(true);
		expect(safeFtpPath('/')).toBe(true);
		expect(safeFtpPath('timelapse')).toBe(false);
		expect(safeFtpPath('/timelapse/../etc')).toBe(false);
		expect(safeFtpPath('/./x')).toBe(false);
		expect(safeFtpPath('/a//b')).toBe(false);
		expect(safeFtpPath('/x\r\nDELE /y')).toBe(false);
		expect(safeFtpPath('/x\\y')).toBe(false);
		expect(safeFtpPath(`/${'a'.repeat(400)}`)).toBe(false);
	});
});

describe('listing and downloading from the printer', () => {
	const opts = (port: number) => ({ host: '127.0.0.1', port, password: '12345678', useTls: false });

	it('lists a folder with MLSD', async () => {
		const server = seeded();
		const port = await server.listen();
		try {
			const list = await listFiles(opts(port), '/timelapse');
			expect(list).toEqual(
				expect.arrayContaining([
					{
						name: 'video_2026-09-01_10-15-00.mp4',
						type: 'file',
						size: 300_000,
						modified: at
					},
					expect.objectContaining({ name: 'thumbnail', type: 'dir' })
				])
			);
			expect((await listFiles(opts(port), '/')).map((e) => e.name).sort()).toEqual([
				'model.gcode.3mf',
				'timelapse'
			]);
		} finally {
			await server.close();
		}
	});

	it('falls back to LIST when the server does not know MLSD', async () => {
		const server = seeded({ noMlsd: true });
		const port = await server.listen();
		try {
			const list = await listFiles(opts(port), '/timelapse');
			expect(list.find((e) => e.type === 'file')).toMatchObject({
				name: 'video_2026-09-01_10-15-00.mp4',
				size: 300_000
			});
		} finally {
			await server.close();
		}
	});

	it('says plainly when a folder is not there', async () => {
		const server = seeded();
		const port = await server.listen();
		try {
			await expect(listFiles(opts(port), '/nothing')).rejects.toBeInstanceOf(FtpNotFound);
			await expect(listFiles(opts(port), '/../x')).rejects.toThrow(/cannot be listed/);
		} finally {
			await server.close();
		}
	});

	it('streams a file with progress', async () => {
		const server = seeded();
		const port = await server.listen();
		try {
			const seen: number[] = [];
			const stream = await downloadFile(
				opts(port),
				'/timelapse/video_2026-09-01_10-15-00.mp4',
				(n) => seen.push(n)
			);
			const data = await collect(stream);
			expect(data.length).toBe(300_000);
			expect(data.every((b) => b === 3)).toBe(true);
			expect(seen.at(-1)).toBe(300_000);
			await expect(downloadFile(opts(port), '/timelapse/missing.mp4')).rejects.toBeInstanceOf(
				FtpNotFound
			);
		} finally {
			await server.close();
		}
	});

	it('lists and downloads over implicit TLS with session reuse', async () => {
		const server = seeded({ tls: selfSigned() });
		const port = await server.listen();
		try {
			const tlsOpts = { host: '127.0.0.1', port, password: '12345678', useTls: true };
			expect((await listFiles(tlsOpts, '/timelapse')).length).toBe(2);
			const data = await collect(
				await downloadFile(tlsOpts, '/timelapse/thumbnail/video_2026-09-01_10-15-00.jpg')
			);
			expect([...data]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
		} finally {
			await server.close();
		}
	});
});
