import net from 'node:net';
import tls from 'node:tls';
import { afterAll, describe, expect, it } from 'vitest';
import {
	BAMBU_CA,
	CERT_CHANGED,
	CERT_UNTRUSTED,
	printerTlsOptions,
	verifyPrinterCert
} from './tls';
import { BambuPrinter } from './bambu';
import { uploadFile } from './ftp';
import { createFtpServer } from './ftp-server';
import { hasOpenssl, testCa, type TestCert } from '../testing/certs';

const SERIAL = 'SIM-TLS-0001';
const run = hasOpenssl() ? describe : describe.skip;

/** A TLS server that records every byte a client writes after the handshake. */
async function recorder(cert: TestCert) {
	const received: Buffer[] = [];
	const server = tls.createServer({ ...cert, maxVersion: 'TLSv1.2' }, (s) => {
		s.on('data', (b) => received.push(b));
		s.on('error', () => {});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
	return {
		port: (server.address() as net.AddressInfo).port,
		received,
		close: () => new Promise<void>((r) => server.close(() => r()))
	};
}

/** Connects with the printer policy and returns what verifyPrinterCert decided. */
function check(
	port: number,
	ca: string,
	o: { pin: string | null; mayPin?: boolean },
	serial = SERIAL
) {
	return new Promise<ReturnType<typeof verifyPrinterCert>>((resolve, reject) => {
		const socket = tls.connect(
			{ host: '127.0.0.1', port, ...printerTlsOptions(serial, [ca]) },
			() => {
				resolve(verifyPrinterCert(socket, { serial, ...o }));
				socket.destroy();
			}
		);
		socket.on('error', reject);
	});
}

run('printer TLS policy', () => {
	const ca = testCa();
	const good = ca.leaf(SERIAL);
	const wrongCn = ca.leaf('SOMEONE-ELSE');
	const selfSigned = ca.leaf(SERIAL, { selfSigned: true });
	const otherSelfSigned = ca.leaf(SERIAL, { selfSigned: true });
	afterAll(() => ca.cleanup());

	it('bundles the Bambu CA certificates', () => {
		expect(BAMBU_CA.length).toBeGreaterThanOrEqual(4);
		expect(BAMBU_CA.every((c) => c.includes('BEGIN CERTIFICATE'))).toBe(true);
		expect(printerTlsOptions(SERIAL)).toMatchObject({ servername: SERIAL, maxVersion: 'TLSv1.2' });
	});

	it('accepts a CA-signed certificate naming the serial', async () => {
		const server = await recorder(good);
		expect(await check(server.port, ca.ca, { pin: null })).toMatchObject({ ok: true, trust: 'ca' });
		// The serial comparison ignores case.
		expect(await check(server.port, ca.ca, { pin: null }, SERIAL.toLowerCase())).toMatchObject({
			ok: true
		});
		await server.close();
	});

	it('pins a CA-verified certificate too, so a later self-signed one is refused', async () => {
		const server = await recorder(good);
		const first = await check(server.port, ca.ca, { pin: null, mayPin: true });
		expect(first).toMatchObject({ ok: true, trust: 'ca' });
		const pin = first.ok ? first.pin! : '';
		expect(pin).toMatch(/^[0-9a-f]{64}$/);
		// Once pinned, a verified chain needs no new pin.
		expect(await check(server.port, ca.ca, { pin })).toEqual({
			ok: true,
			trust: 'ca',
			fingerprint: pin
		});
		await server.close();
		const imposter = await recorder(selfSigned);
		expect(await check(imposter.port, ca.ca, { pin, mayPin: true })).toMatchObject({
			ok: false,
			error: CERT_CHANGED
		});
		await imposter.close();
	});

	it('refuses a CA-signed certificate for another serial', async () => {
		const server = await recorder(wrongCn);
		const r = await check(server.port, ca.ca, { pin: null, mayPin: true });
		expect(r.ok).toBe(false);
		expect(!r.ok && r.error).toMatch(/SOMEONE-ELSE/);
		await server.close();
	});

	it('trusts an unknown chain only on a user-started connection, then pins it', async () => {
		const server = await recorder(selfSigned);
		const refused = await check(server.port, ca.ca, { pin: null });
		expect(refused).toMatchObject({ ok: false, error: CERT_UNTRUSTED });
		const pinned = await check(server.port, ca.ca, { pin: null, mayPin: true });
		expect(pinned).toMatchObject({ ok: true, trust: 'pinned' });
		const pin = pinned.ok ? pinned.pin! : '';
		expect(pin).toMatch(/^[0-9a-f]{64}$/);
		expect(await check(server.port, ca.ca, { pin })).toMatchObject({ ok: true, trust: 'pinned' });
		await server.close();
		// Another certificate for the same serial: refused, with the plain-words hint.
		const imposter = await recorder(otherSelfSigned);
		expect(await check(imposter.port, ca.ca, { pin })).toMatchObject({
			ok: false,
			error: CERT_CHANGED
		});
		await imposter.close();
	});

	it('never writes the access code to a peer that failed the check (MQTT and FTPS)', async () => {
		const server = await recorder(wrongCn);
		const printer = new BambuPrinter(
			{
				id: 'p',
				model: 'C12',
				host: '127.0.0.1',
				port: server.port,
				serial: SERIAL,
				accessCode: 'SECRET12'
			},
			{ ca: [ca.ca], mayPin: true }
		).start();
		for (let i = 0; i < 100 && !printer.error; i++) await new Promise((r) => setTimeout(r, 20));
		printer.stop();
		expect(printer.error).toMatch(/SOMEONE-ELSE/);
		expect(Buffer.concat(server.received).toString('latin1')).not.toContain('SECRET12');
		expect(server.received).toHaveLength(0);
		await server.close();

		const logs: string[] = [];
		const ftp = createFtpServer({ accessCode: 'SECRET12', tls: wrongCn, log: (m) => logs.push(m) });
		const port = await ftp.listen(0);
		await expect(
			uploadFile(
				{
					host: '127.0.0.1',
					port,
					password: 'SECRET12',
					tls: {
						options: printerTlsOptions(SERIAL, [ca.ca]),
						verify: (s) => {
							const r = verifyPrinterCert(s, { serial: SERIAL, pin: null });
							return r.ok ? null : r.error;
						}
					}
				},
				'x.gcode.3mf',
				Buffer.from('x')
			)
		).rejects.toThrow(/SOMEONE-ELSE/);
		expect(logs.join('\n')).not.toMatch(/access code/);
		await ftp.close();
	});

	it('after a CA-verified connection, a reconnect to a self-signed impostor gets nothing', async () => {
		const pins: string[] = [];
		const sockets: tls.TLSSocket[] = [];
		const real = tls.createServer({ ...good, maxVersion: 'TLSv1.2' }, (s) => {
			sockets.push(s);
			s.on('error', () => {});
		});
		await new Promise<void>((r) => real.listen(0, '127.0.0.1', () => r()));
		const imposter = await recorder(selfSigned);
		const printer = new BambuPrinter(
			{
				id: 'p',
				model: 'C12',
				host: '127.0.0.1',
				port: (real.address() as net.AddressInfo).port,
				serial: SERIAL,
				accessCode: 'SECRET12'
			},
			{ ca: [ca.ca], mayPin: true, onPin: (p) => pins.push(p) }
		).start();
		for (let i = 0; i < 100 && !sockets.length; i++) await new Promise((r) => setTimeout(r, 20));
		expect(printer.trust).toBe('ca');
		expect(pins).toHaveLength(1);
		// Someone else answers at the printer's address when it reconnects.
		printer.config.port = imposter.port;
		for (const s of sockets) s.destroy();
		await new Promise<void>((r) => real.close(() => r()));
		for (let i = 0; i < 200 && printer.error !== CERT_CHANGED; i++)
			await new Promise((r) => setTimeout(r, 20));
		printer.stop();
		expect(printer.error).toBe(CERT_CHANGED);
		expect(pins).toHaveLength(1);
		expect(imposter.received).toHaveLength(0);
		await imposter.close();
	});

	it('connects to a printer with a trusted certificate and pins on first use', async () => {
		const pins: string[] = [];
		const server = await recorder(selfSigned);
		const printer = new BambuPrinter(
			{
				id: 'p',
				model: 'C12',
				host: '127.0.0.1',
				port: server.port,
				serial: SERIAL,
				accessCode: 'SECRET12'
			},
			{ ca: [ca.ca], mayPin: true, onPin: (p) => pins.push(p) }
		).start();
		for (let i = 0; i < 100 && !server.received.length; i++)
			await new Promise((r) => setTimeout(r, 20));
		printer.stop();
		// The MQTT CONNECT (with the access code) went out only after the certificate was pinned.
		expect(pins).toHaveLength(1);
		expect(printer.trust).toBe('pinned');
		expect(Buffer.concat(server.received).toString('latin1')).toContain('SECRET12');
		await server.close();
	});
});
