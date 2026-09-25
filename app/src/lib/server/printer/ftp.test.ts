import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
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
});
