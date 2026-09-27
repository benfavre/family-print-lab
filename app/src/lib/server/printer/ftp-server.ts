// A small FTP server that behaves like a Bambu printer's file service, for the simulator and tests:
// login "bblp" + access code, passive mode, binary STOR into memory, and MLSD/LIST/RETR/SIZE over the
// same map (names with slashes are files in folders, e.g. "timelapse/video.mp4"). With TLS it is
// implicit FTPS and, like the printer, refuses data connections that do not resume the control
// connection's session.
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
	/** Refuse MLSD, like servers that only know LIST (tests the fallback): true answers 502. */
	noMlsd?: boolean | 500 | 502 | 550;
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
			cwd = '/',
			authed = false,
			pending: net.Server | null = null,
			dataSocket: Promise<net.Socket> | null = null,
			buffer = '';
		const reply = (code: number, text: string) => control.write(`${code} ${text}\r\n`);
		/** The pending data connection, checked for TLS session reuse like the printer does. */
		const takeData = async (): Promise<net.Socket | null> => {
			if (!authed || !dataSocket) {
				reply(425, 'Use PASV first');
				return null;
			}
			const s = await dataSocket;
			dataSocket = null;
			if (opts.tls && !(s as tls.TLSSocket).isSessionReused()) {
				s.destroy();
				log('✕ file service: data connection without TLS session reuse');
				reply(522, 'SSL connection failed: session reuse required');
				return null;
			}
			return s;
		};
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
						const s = await takeData();
						if (!s) break;
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
					case 'PWD':
						reply(257, `"${cwd}"`);
						break;
					case 'CWD': {
						const dir = resolvePath(cwd, arg);
						if (!isDir(files, dir)) return void reply(550, 'No such folder');
						cwd = `/${dir}`;
						reply(250, 'OK');
						break;
					}
					case 'SIZE': {
						const file = files.get(resolvePath(cwd, arg));
						if (!file) return void reply(550, 'No such file');
						reply(213, String(file.data.length));
						break;
					}
					case 'MLSD':
					case 'LIST': {
						if (verb.toUpperCase() === 'MLSD' && opts.noMlsd) {
							dataSocket?.then((s) => s.destroy());
							dataSocket = null;
							const code = opts.noMlsd === true ? 502 : opts.noMlsd;
							return void reply(
								code,
								code === 550 ? 'Permission denied' : 'Command not implemented'
							);
						}
						const dir = resolvePath(cwd, arg.replace(/^-\w+\s*/, ''));
						if (!isDir(files, dir)) {
							dataSocket?.then((s) => s.destroy());
							dataSocket = null;
							return void reply(550, 'No such folder');
						}
						const s = await takeData();
						if (!s) break;
						reply(150, 'Here comes the listing');
						const lines = entries(files, dir).map((e) =>
							verb.toUpperCase() === 'MLSD' ? mlsdLine(e) : listLine(e)
						);
						s.on('error', () => {});
						s.end(lines.map((l) => `${l}\r\n`).join(''), () => reply(226, 'Listing sent'));
						break;
					}
					case 'RETR': {
						const file = files.get(resolvePath(cwd, arg));
						if (!file) {
							dataSocket?.then((s) => s.destroy());
							dataSocket = null;
							return void reply(550, 'No such file');
						}
						const s = await takeData();
						if (!s) break;
						reply(150, 'Opening data connection');
						s.on('error', () => {});
						s.end(file.data, () => reply(226, 'Transfer complete'));
						log(`⤒ sent ${arg}`);
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

/** A path from the control line as a key of the file map ("timelapse/a.mp4", "" for the root). */
function resolvePath(cwd: string, arg: string): string {
	const full = arg.startsWith('/') ? arg : `${cwd.replace(/\/$/, '')}/${arg}`;
	const parts: string[] = [];
	for (const part of full.split('/')) {
		if (!part || part === '.') continue;
		if (part === '..') parts.pop();
		else parts.push(part);
	}
	return parts.join('/');
}

function isDir(files: Map<string, StoredFile>, dir: string): boolean {
	if (!dir) return true;
	for (const key of files.keys()) if (key.startsWith(`${dir}/`)) return true;
	return false;
}

interface Entry {
	name: string;
	dir: boolean;
	size: number;
	at: Date;
}

/** What is directly inside a folder: files, and folders implied by longer names. */
function entries(files: Map<string, StoredFile>, dir: string): Entry[] {
	const prefix = dir ? `${dir}/` : '';
	const out = new Map<string, Entry>();
	for (const [key, file] of files) {
		if (!key.startsWith(prefix)) continue;
		const rest = key.slice(prefix.length);
		const slash = rest.indexOf('/');
		const at = new Date(file.at ?? Date.now());
		if (slash < 0) out.set(rest, { name: rest, dir: false, size: file.data.length, at });
		else if (!out.has(rest.slice(0, slash)))
			out.set(rest.slice(0, slash), { name: rest.slice(0, slash), dir: true, size: 0, at });
	}
	return [...out.values()];
}

const pad = (n: number) => String(n).padStart(2, '0');

function mlsdLine(e: Entry): string {
	const t = e.at;
	const modify = `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}`;
	return `type=${e.dir ? 'dir' : 'file'};${e.dir ? '' : `size=${e.size};`}modify=${modify}; ${e.name}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The Unix `ls -l` shape most FTP servers use for LIST. */
function listLine(e: Entry): string {
	const t = e.at;
	return `${e.dir ? 'drwxr-xr-x' : '-rw-r--r--'} 1 root root ${String(e.size).padStart(10)} ${MONTHS[t.getUTCMonth()]} ${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())} ${e.name}`;
}
