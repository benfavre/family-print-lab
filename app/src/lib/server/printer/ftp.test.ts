import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { uploadFile } from './ftp';
import { createFtpServer } from './ftp-server';
import { fakeSliced, readSliced } from './sliced';

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

describe('sliced print files', () => {
	it('reads time, weight, layers, filaments and the G-code checksum', () => {
		const file = readSliced(
			fakeSliced({
				minutes: 83,
				grams: 18.5,
				layers: 150,
				filaments: [
					{ type: 'PLA', color: '#FF0000', grams: 14.2 },
					{ type: 'PETG', color: '#FFFFFF', grams: 4.3 }
				]
			})
		);
		expect(file.printerModelId).toBe('N6');
		expect(file.slicer).toBe('slicer 02.08.02.61');
		expect(file.plates).toHaveLength(1);
		expect(file.plates[0]).toMatchObject({
			index: 1,
			gcode: 'Metadata/plate_1.gcode',
			minutes: 83,
			grams: 18.5,
			layers: 150
		});
		expect(file.plates[0].md5).toMatch(/^[0-9A-F]{32}$/);
		expect(file.plates[0].filaments.map((f) => f.type)).toEqual(['PLA', 'PETG']);
	});

	it('explains that an unsliced 3MF must be sliced first', () => {
		const unsliced = fakeSliced({ minutes: 1, grams: 1 });
		// Same container without the plate G-code is what "Export 3MF" (not sliced) produces.
		const text = unsliced.toString('latin1').replace(/plate_1\.gcode/g, 'plate_1.gcodx');
		expect(() => readSliced(Buffer.from(text, 'latin1'))).toThrow(/not been sliced/);
		expect(() => readSliced(Buffer.from('not a zip'))).toThrow(/zip/);
	});
});

describe('uploading to the printer', () => {
	it('uploads over plain FTP to the simulator', async () => {
		const server = createFtpServer({ accessCode: '12345678' });
		const port = await server.listen();
		try {
			const data = Buffer.alloc(700_000, 7);
			const seen: number[] = [];
			await uploadFile(
				{ host: '127.0.0.1', port, password: '12345678', useTls: false },
				'part.gcode.3mf',
				data,
				(f) => seen.push(f)
			);
			expect(server.files.get('part.gcode.3mf')?.data.equals(data)).toBe(true);
			expect(seen.at(-1)).toBe(1);
		} finally {
			await server.close();
		}
	});

	it('uses implicit TLS and resumes the control session for the data connection, like the printer requires', async () => {
		const server = createFtpServer({ accessCode: '12345678', tls: selfSigned() });
		const port = await server.listen();
		try {
			await uploadFile(
				{ host: '127.0.0.1', port, password: '12345678', useTls: true },
				'tls part.gcode.3mf',
				Buffer.from('hello printer')
			);
			expect(server.files.get('tls part.gcode.3mf')?.data.toString()).toBe('hello printer');
		} finally {
			await server.close();
		}
	});

	it('reports a wrong access code plainly', async () => {
		const server = createFtpServer({ accessCode: '12345678' });
		const port = await server.listen();
		try {
			await expect(
				uploadFile(
					{ host: '127.0.0.1', port, password: 'nope', useTls: false },
					'x.gcode.3mf',
					Buffer.from('x')
				)
			).rejects.toThrow(/access code/);
		} finally {
			await server.close();
		}
	});

	it('fails cleanly, without crashing the app, when the printer never confirms the file', async () => {
		// A file service that accepts the data connection but never answers STOR.
		const server = net.createServer((c) => {
			c.write('220 hi\r\n');
			c.on('data', (b) => {
				const line = b.toString();
				if (line.startsWith('USER')) c.write('331 pw\r\n');
				else if (line.startsWith('PASS')) c.write('230 ok\r\n');
				else if (line.startsWith('TYPE')) c.write('200 ok\r\n');
				else if (line.startsWith('PASV')) {
					const data = net.createServer((d) => d.on('error', () => {}));
					data.listen(0, '127.0.0.1', () => {
						const port = (data.address() as net.AddressInfo).port;
						c.write(`227 Entering Passive Mode (127,0,0,1,${port >> 8},${port & 255})\r\n`);
					});
				}
			});
			c.on('error', () => {});
		});
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
		const port = (server.address() as net.AddressInfo).port;
		const crashes: unknown[] = [];
		const onCrash = (e: unknown) => crashes.push(e);
		process.on('uncaughtException', onCrash);
		try {
			await expect(
				uploadFile(
					{ host: '127.0.0.1', port, password: 'x', useTls: false, timeoutMs: 300 },
					'slow.gcode.3mf',
					Buffer.from('data')
				)
			).rejects.toThrow(/did not answer/);
			await new Promise((r) => setTimeout(r, 800));
			expect(crashes).toEqual([]);
		} finally {
			process.off('uncaughtException', onCrash);
			server.close();
		}
	});
});

describe('rewriting sliced files', () => {
	it('replaces a few entries and copies the rest byte for byte', async () => {
		const { rewriteZip, readZip } = await import('../cad/mesh');
		const original = fakeSliced({ minutes: 5, grams: 2 });
		const out = rewriteZip(
			original,
			new Map([['Metadata/slice_info.config', Buffer.from('<config/>')]])
		);
		const before = readZip(original, () => 'all');
		const after = readZip(out, () => 'all');
		expect(after.get('Metadata/slice_info.config')?.toString()).toBe('<config/>');
		expect(after.get('Metadata/plate_1.gcode')?.equals(before.get('Metadata/plate_1.gcode')!)).toBe(
			true
		);
		expect(() =>
			readZip(Buffer.concat([original.subarray(0, 100), original.subarray(-22)]))
		).toThrow(/Corrupt|valid/);
	});
});
