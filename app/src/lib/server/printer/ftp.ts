// Uploading print files to a Bambu printer: FTP over implicit TLS on port 990, user "bblp" and the
// access code. The printer insists that the data connection resumes the control connection's TLS
// session ("522 session reuse required"), which is why this small client exists instead of a library.
// Plain FTP (no TLS) is used against the simulator.
import net from 'node:net';
import tls from 'node:tls';

export interface FtpOptions {
	host: string;
	port?: number;
	user?: string;
	password: string;
	useTls?: boolean;
	timeoutMs?: number;
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

function open(opts: Required<FtpOptions>, port: number, session?: Buffer): Promise<Sock> {
	return new Promise((resolve, reject) => {
		const done = (s: Sock) => {
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
						host: opts.host,
						port,
						session,
						// The printer's certificate is self-signed; the access code is the credential.
						rejectUnauthorized: false,
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
	const opts: Required<FtpOptions> = {
		port: options.useTls === false ? 21 : 990,
		user: 'bblp',
		useTls: true,
		timeoutMs: 20_000,
		...options
	};
	if (!/^[\w .()+-]{1,120}$/.test(name))
		throw new Error('That file name cannot be sent to the printer.');
	const socket = await open(opts, opts.port);
	const control = new Control(socket, opts.timeoutMs);
	let dataSocket: Sock | null = null;
	const cancel = () => {
		dataSocket?.destroy(new Error('Stopped'));
		socket.destroy(new Error('Stopped'));
	};
	signal?.addEventListener('abort', cancel, { once: true });
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
		const pasv = await control.send('PASV', [227]);
		const nums = pasv.match(/(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/);
		if (!nums) throw new Error('The printer sent an unexpected passive-mode reply.');
		// Printers behind odd routers report the wrong address; the control host is the one that works.
		const dataPort = Number(nums[5]) * 256 + Number(nums[6]);
		const session =
			socket instanceof tls.TLSSocket ? (control.session ?? socket.getSession()) : undefined;
		const data$ = (dataSocket = await open(opts, dataPort, session));
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
