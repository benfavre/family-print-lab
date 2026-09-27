// Uploading print files to a Bambu printer: FTP over implicit TLS on port 990, user "bblp" and the
// access code. The printer insists that the data connection resumes the control connection's TLS
// session ("522 session reuse required"), which is why this small client exists instead of a library.
// Plain FTP (no TLS) is used against the simulator. Besides uploads it lists folders (MLSD, falling
// back to LIST, which ha-bambulab pybambu/media_sources.py Ftps990MediaSource uses) and streams
// downloads, for the camera package's timelapse browser.
import net from 'node:net';
import tls from 'node:tls';
import { PassThrough, type Readable } from 'node:stream';

export interface FtpOptions {
	host: string;
	port?: number;
	user?: string;
	password: string;
	useTls?: boolean;
	timeoutMs?: number;
	/**
	 * TLS settings and the certificate check from printer/tls.ts: the check runs once the handshake is
	 * done, before USER/PASS, so the access code never reaches an unverified peer.
	 */
	tls?: { options: tls.ConnectionOptions; verify?: (socket: tls.TLSSocket) => string | null };
}

type Sock = net.Socket | tls.TLSSocket;

class Control {
	private buffer = '';
	private waiting: ((line: { code: number; text: string }) => void)[] = [];
	private replies: { code: number; text: string }[] = [];
	private failure: Error | null = null;
	session: Buffer | undefined;

	constructor(
		readonly socket: Sock,
		private timeoutMs: number
	) {
		socket.setEncoding('utf8');
		socket.on('data', (chunk: string) => this.feed(chunk));
		socket.on('error', (error) => this.fail(error));
		socket.on('close', () => this.fail(new Error('The printer closed the file connection.')));
		if (socket instanceof tls.TLSSocket) socket.on('session', (s: Buffer) => (this.session = s));
	}

	private feed(chunk: string) {
		this.buffer += chunk;
		// A reply ends with "NNN text"; "NNN-" lines continue it.
		let m: RegExpMatchArray | null;
		while ((m = this.buffer.match(/^(?:.*\r?\n)*?(\d{3}) (.*)\r?\n/))) {
			this.buffer = this.buffer.slice(m[0].length);
			const reply = { code: Number(m[1]), text: m[2] };
			const next = this.waiting.shift();
			if (next) next(reply);
			else this.replies.push(reply);
		}
	}

	private fail(error: Error) {
		this.failure ??= error;
		for (const w of this.waiting.splice(0)) w({ code: 0, text: this.failure.message });
	}

	read(): Promise<{ code: number; text: string }> {
		const ready = this.replies.shift();
		if (ready) return Promise.resolve(ready);
		if (this.failure) return Promise.resolve({ code: 0, text: this.failure.message });
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error('The printer did not answer in time.')),
				this.timeoutMs
			);
			this.waiting.push((r) => {
				clearTimeout(timer);
				resolve(r);
			});
		});
	}

	async send(command: string, expect: number[]): Promise<string> {
		this.socket.write(`${command}\r\n`);
		const reply = await this.read();
		if (!expect.includes(reply.code)) throw ftpError(command, reply);
		return reply.text;
	}
}

function ftpError(command: string, reply: { code: number; text: string }) {
	const verb = command.split(' ')[0];
	if (reply.code === 530) return new Error('The printer refused the access code.');
	if (reply.code === 522)
		return new Error('The printer refused the file connection (TLS session reuse).');
	if (reply.code === 553 || reply.code === 550)
		return new Error(
			`The printer could not store the file (${reply.text}). Is there storage (a USB stick) in it?`
		);
	if (reply.code === 0) return new Error(reply.text || 'The file connection failed.');
	return new Error(`Printer file transfer failed at ${verb}: ${reply.code} ${reply.text}`);
}

type Resolved = Required<Omit<FtpOptions, 'tls'>> & Pick<FtpOptions, 'tls'>;

function resolveOptions(options: FtpOptions): Resolved {
	return {
		port: options.useTls === false ? 21 : 990,
		user: 'bblp',
		useTls: true,
		timeoutMs: 20_000,
		...options
	};
}

function open(opts: Resolved, port: number, session?: Buffer): Promise<Sock> {
	return new Promise((resolve, reject) => {
		const done = (s: Sock) => {
			const refused = s instanceof tls.TLSSocket ? opts.tls?.verify?.(s) : null;
			if (refused) {
				s.destroy();
				return reject(new Error(refused));
			}
			s.off('error', reject);
			// Connected: drop the connect timeout (the control line may sit quiet during a long upload)
			// and keep an error listener at all times, so a reset can never become an uncaught error.
			s.removeAllListeners('timeout');
			s.setTimeout(0);
			s.on('error', () => {});
			resolve(s);
		};
		const socket: Sock = opts.useTls
			? tls.connect(
					{
						// Without a policy (the simulator) nothing is checked; printers get printer/tls.ts.
						rejectUnauthorized: false,
						...opts.tls?.options,
						host: opts.host,
						port,
						session,
						// Session reuse is dependable with TLS 1.2 on the printer's FTP server.
						maxVersion: 'TLSv1.2'
					},
					() => done(socket)
				)
			: net.connect({ host: opts.host, port }, () => done(socket));
		socket.once('error', reject);
		socket.setTimeout(opts.timeoutMs, () =>
			socket.destroy(new Error('The printer did not answer in time.'))
		);
	});
}

/** A logged-in control connection. */
interface Session {
	opts: Resolved;
	socket: Sock;
	control: Control;
}

async function login(opts: Resolved): Promise<Session> {
	const socket = await open(opts, opts.port);
	const control = new Control(socket, opts.timeoutMs);
	try {
		const hello = await control.read();
		if (hello.code !== 220) throw ftpError('CONNECT', hello);
		await control.send(`USER ${opts.user}`, [331, 230]);
		await control.send(`PASS ${opts.password}`, [230, 202]);
		if (opts.useTls) {
			await control.send('PBSZ 0', [200]);
			await control.send('PROT P', [200]);
		}
		await control.send('TYPE I', [200]);
		return { opts, socket, control };
	} catch (error) {
		socket.destroy();
		throw error;
	}
}

/** PASV, then the data connection, resuming the control connection's TLS session. */
async function passive({ opts, socket, control }: Session): Promise<Sock> {
	const pasv = await control.send('PASV', [227]);
	const nums = pasv.match(/(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/);
	if (!nums) throw new Error('The printer sent an unexpected passive-mode reply.');
	// Printers behind odd routers report the wrong address; the control host is the one that works.
	const dataPort = Number(nums[5]) * 256 + Number(nums[6]);
	const session =
		socket instanceof tls.TLSSocket ? (control.session ?? socket.getSession()) : undefined;
	return open(opts, dataPort, session);
}

function quit({ socket }: Session) {
	if (!socket.destroyed) socket.write('QUIT\r\n');
	setTimeout(() => socket.destroy(), 200).unref();
}

/**
 * Uploads a file to the printer's storage root and returns its name there. `onProgress` gets the
 * fraction sent (0 to 1).
 */
export async function uploadFile(
	options: FtpOptions,
	name: string,
	data: Buffer,
	onProgress?: (fraction: number) => void,
	signal?: AbortSignal
): Promise<string> {
	const opts = resolveOptions(options);
	if (!/^[\w .()+-]{1,120}$/.test(name))
		throw new Error('That file name cannot be sent to the printer.');
	const session = await login(opts);
	const { socket, control } = session;
	let dataSocket: Sock | null = null;
	const cancel = () => {
		dataSocket?.destroy(new Error('Stopped'));
		socket.destroy(new Error('Stopped'));
	};
	signal?.addEventListener('abort', cancel, { once: true });
	try {
		const data$ = (dataSocket = await passive(session));
		// A transfer that stalls for this long has failed.
		data$.setTimeout(opts.timeoutMs, () =>
			data$.destroy(new Error('The upload to the printer stalled.'))
		);
		socket.write(`STOR ${name}\r\n`);
		const accepted = await control.read();
		if (accepted.code !== 150 && accepted.code !== 125) throw ftpError('STOR', accepted);
		await new Promise<void>((resolve, reject) => {
			const CHUNK = 256 * 1024;
			let offset = 0;
			data$.on('error', reject);
			const pump = () => {
				while (offset < data.length) {
					const end = Math.min(data.length, offset + CHUNK);
					const more = data$.write(data.subarray(offset, end));
					offset = end;
					onProgress?.(offset / data.length);
					if (!more) return void data$.once('drain', pump);
				}
				data$.end();
			};
			data$.once('close', (hadError) =>
				hadError ? reject(new Error('The upload to the printer was interrupted.')) : resolve()
			);
			pump();
		});
		const stored = await control.read();
		if (stored.code !== 226 && stored.code !== 250) throw ftpError('STOR', stored);
		socket.write('QUIT\r\n');
		return name;
	} catch (error) {
		if (signal?.aborted) throw new Error('Stopped', { cause: error });
		throw error;
	} finally {
		signal?.removeEventListener('abort', cancel);
		dataSocket?.destroy();
		setTimeout(() => socket.destroy(), 200).unref();
	}
}

// ---------- Listing and downloading ----------

export interface FtpEntry {
	name: string;
	type: 'file' | 'dir';
	/** Bytes; null when the server did not say. */
	size: number | null;
	/** ISO time (UTC); null when the server did not say. */
	modified: string | null;
}

/**
 * Whether a path is safe to put on the FTP control line: absolute, no "." or ".." segments, no
 * control characters (a CR/LF would start another command) and not absurdly long.
 */
export function safeFtpPath(path: string): boolean {
	if (typeof path !== 'string' || !path.startsWith('/') || path.length > 300) return false;
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f\\]/.test(path)) return false;
	return path
		.split('/')
		.slice(1)
		.every((segment, i, all) => (segment === '' ? i === all.length - 1 : !/^\.\.?$/.test(segment)));
}

/** One MLSD line ("type=file;size=12;modify=20260901101500; name.mp4"), or null for . and .. and junk. */
export function parseMlsdLine(line: string): FtpEntry | null {
	const space = line.indexOf(' ');
	if (space < 0) return null;
	const name = line.slice(space + 1);
	const facts = new Map(
		line
			.slice(0, space)
			.split(';')
			.filter(Boolean)
			.map((f) => {
				const eq = f.indexOf('=');
				return [f.slice(0, eq).toLowerCase(), f.slice(eq + 1)] as const;
			})
	);
	const type = facts.get('type')?.toLowerCase();
	if (!name || (type !== 'file' && type !== 'dir')) return null;
	const size = Number(facts.get('size'));
	const m = facts.get('modify')?.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
	return {
		name,
		type,
		size: type === 'file' && Number.isFinite(size) ? size : null,
		modified: m
			? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString()
			: null
	};
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * One Unix-style LIST line ("-rw-r--r-- 1 root root 1234 Sep 01 10:15 name.mp4"), or null. A time
 * without a year is within the last six months (the `ls -l` convention), so it is this year unless
 * that would put it in the future (two days of clock slack), then last year.
 */
export function parseListLine(line: string, now = new Date()): FtpEntry | null {
	const m = line.match(
		/^([-dl])[rwxsStT-]{9}\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}:\d{2}|\d{4})\s+(.+)$/
	);
	if (!m) return null;
	const [, kind, size, mon, day, timeOrYear, rawName] = m;
	const name = kind === 'l' ? rawName.replace(/ -> .*$/, '') : rawName;
	if (name === '.' || name === '..') return null;
	const month = MONTHS.indexOf(mon.toLowerCase());
	let modified: string | null = null;
	if (month >= 0) {
		if (timeOrYear.includes(':')) {
			const [h, min] = timeOrYear.split(':').map(Number);
			let date = Date.UTC(now.getUTCFullYear(), month, Number(day), h, min);
			if (date - now.getTime() > 2 * 86_400_000)
				date = Date.UTC(now.getUTCFullYear() - 1, month, Number(day), h, min);
			modified = new Date(date).toISOString();
		} else modified = new Date(Date.UTC(Number(timeOrYear), month, Number(day))).toISOString();
	}
	return {
		name,
		type: kind === 'd' ? 'dir' : 'file',
		size: kind === 'd' ? null : Number(size),
		modified
	};
}

/** Reads a whole data connection as text. */
function readAll(data: Sock, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const parts: Buffer[] = [];
		data.setTimeout(timeoutMs, () =>
			data.destroy(new Error('The printer did not answer in time.'))
		);
		data.on('data', (b: Buffer) => parts.push(b));
		data.on('error', reject);
		data.once('close', () => resolve(Buffer.concat(parts).toString('utf8')));
	});
}

/** Missing folder or file. */
export class FtpNotFound extends Error {}

/**
 * Lists a folder on the printer's storage: MLSD first, LIST when the server does not know MLSD.
 * Throws FtpNotFound when the folder is not there.
 */
export async function listFiles(
	options: FtpOptions,
	dir: string,
	signal?: AbortSignal
): Promise<FtpEntry[]> {
	if (!safeFtpPath(dir)) throw new Error('That folder cannot be listed.');
	const opts = resolveOptions(options);
	const session = await login(opts);
	const { socket, control } = session;
	let dataSocket: Sock | null = null;
	const cancel = () => socket.destroy(new Error('Stopped'));
	signal?.addEventListener('abort', cancel, { once: true });
	const run = async (verb: 'MLSD' | 'LIST') => {
		const data = (dataSocket = await passive(session));
		const text = readAll(data, opts.timeoutMs);
		socket.write(`${verb} ${dir}\r\n`);
		const accepted = await control.read();
		if (accepted.code !== 150 && accepted.code !== 125) {
			data.destroy();
			return { reply: accepted, text: '' };
		}
		const body = await text;
		const done = await control.read();
		if (done.code !== 226 && done.code !== 250) throw ftpError(verb, done);
		return { reply: accepted, text: body };
	};
	try {
		let { reply, text } = await run('MLSD');
		let parse: (line: string) => FtpEntry | null = parseMlsdLine;
		// Any refusal (500/502/504 not implemented, 501 syntax, and servers that answer an unknown
		// command with 550) gets one more try with LIST, the command ha-bambulab uses on real printers;
		// only LIST's answer decides whether the folder is missing.
		if (reply.code !== 150 && reply.code !== 125 && reply.code !== 0) {
			({ reply, text } = await run('LIST'));
			parse = (line) => parseListLine(line);
		}
		if (reply.code === 550 || reply.code === 450) throw new FtpNotFound(`${dir} is not there.`);
		if (reply.code !== 150 && reply.code !== 125) throw ftpError('LIST', reply);
		quit(session);
		return text
			.split(/\r?\n/)
			.map((line) => (line.trim() ? parse(line) : null))
			.filter((e): e is FtpEntry => !!e);
	} catch (error) {
		if (signal?.aborted) throw new Error('Stopped', { cause: error });
		throw error;
	} finally {
		signal?.removeEventListener('abort', cancel);
		(dataSocket as Sock | null)?.destroy();
		setTimeout(() => socket.destroy(), 200).unref();
	}
}

/**
 * Streams one file from the printer's storage (never held in memory as a whole). `onProgress` gets
 * the bytes received so far. Throws FtpNotFound when the file is not there; the returned stream errors
 * when the transfer breaks off.
 */
export async function downloadFile(
	options: FtpOptions,
	path: string,
	onProgress?: (bytes: number) => void,
	signal?: AbortSignal
): Promise<Readable> {
	if (!safeFtpPath(path) || path.endsWith('/')) throw new Error('That file cannot be downloaded.');
	const opts = resolveOptions(options);
	const session = await login(opts);
	const { socket, control } = session;
	let data: Sock | null = null;
	const out = new PassThrough();
	const cancel = () => {
		data?.destroy();
		socket.destroy();
		out.destroy(new Error('Stopped'));
	};
	signal?.addEventListener('abort', cancel, { once: true });
	const cleanup = () => {
		signal?.removeEventListener('abort', cancel);
		data?.destroy();
		setTimeout(() => socket.destroy(), 200).unref();
	};
	try {
		const data$ = (data = await passive(session));
		socket.write(`RETR ${path}\r\n`);
		const accepted = await control.read();
		if (accepted.code === 550 || accepted.code === 450)
			throw new FtpNotFound(`${path} is not there.`);
		if (accepted.code !== 150 && accepted.code !== 125) throw ftpError('RETR', accepted);
		let received = 0;
		data$.setTimeout(opts.timeoutMs, () =>
			data$.destroy(new Error('The download from the printer stalled.'))
		);
		data$.on('data', (b: Buffer) => {
			received += b.length;
			onProgress?.(received);
			if (!out.write(b)) data$.pause();
		});
		out.on('drain', () => data$.resume());
		// The person closed the download: let the printer go too.
		out.once('close', () => {
			if (!out.writableFinished) cleanup();
		});
		data$.once('error', (error) => out.destroy(error));
		data$.once('end', async () => {
			const done = await control.read().catch((e: Error) => ({ code: 0, text: e.message }));
			if (done.code === 226 || done.code === 250) {
				out.end();
				quit(session);
			} else out.destroy(ftpError('RETR', done));
			cleanup();
		});
		return out;
	} catch (error) {
		cleanup();
		if (signal?.aborted) throw new Error('Stopped', { cause: error });
		throw error;
	}
}
