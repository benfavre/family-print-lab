// A small FTP server that behaves like a Bambu printer's file service, for the simulator and tests:
// login "bblp" + access code, passive mode, binary STOR into memory. With TLS it is implicit FTPS and,
// like the printer, refuses data connections that do not resume the control connection's session.
import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

export interface StoredFile {
	name: string;
	data: Buffer;
	at: string;
}

export function createFtpServer(opts: {
	accessCode: string;
	host?: string;
	tls?: { key: string | Buffer; cert: string | Buffer };
	log?: (message: string) => void;
	onStored?: (file: StoredFile) => void;
}) {
	const files = new Map<string, StoredFile>();
	const log = opts.log ?? (() => {});
	const host = opts.host ?? '127.0.0.1';
	const sockets = new Set<net.Socket>();
	// Control and data listeners share ticket keys, so a data connection can resume the control session.
	const ticketKeys = crypto.randomBytes(48);
	const listen = (handler: (s: net.Socket) => void) =>
		opts.tls
			? tls.createServer({ ...opts.tls, ticketKeys, maxVersion: 'TLSv1.2' }, handler)
			: net.createServer(handler);

	const server = listen((control) => {
		sockets.add(control);
		control.on('close', () => sockets.delete(control));
		control.on('error', () => {});
		let user = '',
			authed = false,
			pending: net.Server | null = null,
			dataSocket: Promise<net.Socket> | null = null,
			buffer = '';
		const reply = (code: number, text: string) => control.write(`${code} ${text}\r\n`);
		reply(220, 'Print Lab simulator file service ready');
		control.setEncoding('utf8');
		control.on('data', async (chunk: string) => {
			buffer += chunk;
			let i: number;
			while ((i = buffer.indexOf('\r\n')) >= 0) {
				const line = buffer.slice(0, i);
				buffer = buffer.slice(i + 2);
				const [verb, ...rest] = line.split(' ');
				const arg = rest.join(' ');
				switch (verb.toUpperCase()) {
					case 'USER':
						user = arg;
						reply(331, 'Password required');
						break;
					case 'PASS':
						authed = user === 'bblp' && arg === opts.accessCode;
						if (authed) reply(230, 'Logged in');
						else {
							log('✕ file service: wrong access code');
							reply(530, 'Login incorrect');
						}
						break;
					case 'PBSZ':
					case 'PROT':
					case 'TYPE':
						reply(200, 'OK');
						break;
					case 'PASV': {
						if (!authed) return void reply(530, 'Please login');
						pending?.close();
						const data = listen(() => {});
						pending = data;
						dataSocket = new Promise((resolve) => {
							data.removeAllListeners(opts.tls ? 'secureConnection' : 'connection');
							data.once(opts.tls ? 'secureConnection' : 'connection', (s: net.Socket) => {
								data.close();
								resolve(s);
							});
						});
						await new Promise<void>((r) => data.listen(0, host, () => r()));
						const port = (data.address() as net.AddressInfo).port;
						reply(
							227,
							`Entering Passive Mode (${host.split('.').join(',')},${port >> 8},${port & 255})`
						);
						break;
					}
					case 'STOR': {
						if (!authed || !dataSocket) return void reply(425, 'Use PASV first');
						const s = await dataSocket;
						dataSocket = null;
						if (opts.tls && !(s as tls.TLSSocket).isSessionReused()) {
							s.destroy();
							log('✕ file service: data connection without TLS session reuse');
							return void reply(522, 'SSL connection failed: session reuse required');
						}
						reply(150, 'Ok to send data');
						const parts: Buffer[] = [];
						s.on('data', (b: Buffer) => parts.push(b));
						s.on('error', () => {});
						s.once('end', () => {
							const file = { name: arg, data: Buffer.concat(parts), at: new Date().toISOString() };
							files.set(arg, file);
							log(`⤓ received ${arg} (${Math.round(file.data.length / 1024)} KB)`);
							opts.onStored?.(file);
							reply(226, 'Transfer complete');
						});
						break;
					}
					case 'QUIT':
						reply(221, 'Goodbye');
						control.end();
						break;
					default:
						reply(502, 'Command not implemented');
				}
			}
		});
	});

	return {
		files,
		listen(port = 0): Promise<number> {
			return new Promise((resolve) =>
				server.listen(port, host, () => resolve((server.address() as net.AddressInfo).port))
			);
		},
		close(): Promise<void> {
			for (const s of sockets) s.destroy();
			return new Promise((r) => server.close(() => r()));
		}
	};
}
