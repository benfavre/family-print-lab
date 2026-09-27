// A minimal SMTP client for email notifications (RFC 5321): implicit TLS (port 465) or STARTTLS
// (RFC 3207, port 587, required: never signs in over plain text), AUTH PLAIN or LOGIN (RFC 4954),
// one recipient, a plain-text body and optionally a JPEG, sent as base64 MIME (RFC 2045/2046).
import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { encodeWords } from './http';

export interface MailOptions {
	host: string;
	port: number;
	security: 'tls' | 'starttls';
	user: string;
	password: string | null;
	from: string;
	to: string;
	subject: string;
	text: string;
	picture: Buffer | null;
	signal: AbortSignal;
	/** Extra TLS options (tests pass their own CA). */
	tls?: tls.ConnectionOptions;
}

interface Reply {
	code: number;
	lines: string[];
}

/** Reads SMTP replies (multi-line "250-…" until "250 …") from a socket that may be swapped for TLS. */
class Replies {
	private buf = '';
	private lines: string[] = [];
	private ready: Reply[] = [];
	private waiting: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
	private error: Error | null = null;
	private socket!: net.Socket;
	private onData = (chunk: Buffer) => {
		this.buf += chunk.toString('utf8');
		let at: number;
		while ((at = this.buf.indexOf('\r\n')) >= 0) {
			const line = this.buf.slice(0, at);
			this.buf = this.buf.slice(at + 2);
			this.lines.push(line.slice(4));
			if (line[3] === '-') continue;
			this.push({ code: Number(line.slice(0, 3)) || 0, lines: this.lines });
			this.lines = [];
		}
	};
	private onEnd = (error?: Error) => {
		this.error ??= error ?? new Error('The mail server closed the connection.');
		this.waiting?.reject(this.error);
		this.waiting = null;
	};

	private onClose = () => this.onEnd();

	attach(socket: net.Socket) {
		this.detach();
		this.socket = socket;
		socket.on('data', this.onData);
		socket.on('error', this.onEnd);
		socket.on('close', this.onClose);
	}

	/** Stops reading (before the socket is handed to TLS). */
	detach() {
		this.socket?.off('data', this.onData);
		this.socket?.off('error', this.onEnd);
		this.socket?.off('close', this.onClose);
	}

	/** Anything read but not yet used (after STARTTLS it would be plain text injected before TLS). */
	get unread() {
		return this.buf.length + this.lines.length + this.ready.length > 0;
	}

	private push(r: Reply) {
		if (this.waiting) {
			this.waiting.resolve(r);
			this.waiting = null;
		} else this.ready.push(r);
	}

	next(): Promise<Reply> {
		const r = this.ready.shift();
		if (r) return Promise.resolve(r);
		if (this.error) return Promise.reject(this.error);
		return new Promise((resolve, reject) => (this.waiting = { resolve, reject }));
	}

	async expect(codes: number[], line?: string): Promise<Reply> {
		if (line !== undefined) this.socket.write(`${line}\r\n`);
		const r = await this.next();
		if (codes.includes(r.code)) return r;
		if (r.code === 535)
			throw new Error('The mail server did not accept the user name or password.');
		throw new Error(`The mail server said ${r.code} ${r.lines.join(' ').slice(0, 160)}`.trim());
	}
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const wrap = (s: string) => s.replace(/.{1,76}/g, '$&\r\n');

/** The message: headers and a base64 body (a multipart one when a picture goes along). */
export function mailMessage(o: Pick<MailOptions, 'from' | 'to' | 'subject' | 'text' | 'picture'>) {
	const head = [
		`From: Family Print Lab <${o.from}>`,
		`To: <${o.to}>`,
		`Subject: ${encodeWords(o.subject)}`,
		`Date: ${new Date().toUTCString()}`,
		`Message-ID: <${randomUUID()}@family-print-lab>`,
		'MIME-Version: 1.0'
	];
	const text = [
		'Content-Type: text/plain; charset=utf-8',
		'Content-Transfer-Encoding: base64',
		'',
		wrap(b64(o.text))
	];
	if (!o.picture) return [...head, ...text].join('\r\n');
	const boundary = `plab-${randomUUID()}`;
	return [
		...head,
		`Content-Type: multipart/mixed; boundary="${boundary}"`,
		'',
		`--${boundary}`,
		...text,
		`--${boundary}`,
		'Content-Type: image/jpeg; name="snapshot.jpg"',
		'Content-Disposition: attachment; filename="snapshot.jpg"',
		'Content-Transfer-Encoding: base64',
		'',
		wrap(o.picture.toString('base64')),
		`--${boundary}--`,
		''
	].join('\r\n');
}

export async function sendMail(o: MailOptions): Promise<string> {
	const options = { host: o.host, port: o.port, servername: o.host, ...o.tls };
	let socket: net.Socket =
		o.security === 'tls' ? tls.connect(options) : net.connect({ host: o.host, port: o.port });
	const replies = new Replies();
	replies.attach(socket);
	const abort = () => socket.destroy(new Error('No answer in time.'));
	o.signal.addEventListener('abort', abort, { once: true });
	try {
		await replies.expect([220]);
		let ehlo = await replies.expect([250], 'EHLO localhost');
		if (o.security === 'starttls') {
			if (!ehlo.lines.some((l) => /^STARTTLS\b/i.test(l)))
				throw new Error('The mail server does not offer STARTTLS, so nothing was sent.');
			await replies.expect([220], 'STARTTLS');
			replies.detach();
			// Anything sent before the TLS handshake could be forged by anyone on the path, so none of it
			// may be carried over (RFC 3207 section 4.2: discard what was not obtained over TLS).
			if (replies.unread)
				throw new Error('The mail server sent more before STARTTLS, so nothing was sent.');
			const secure = tls.connect({ ...options, socket });
			await new Promise<void>((resolve, reject) => {
				secure.once('secureConnect', resolve);
				secure.once('error', reject);
			});
			socket = secure;
			replies.attach(secure);
			ehlo = await replies.expect([250], 'EHLO localhost');
		}
		if (o.user) {
			const auth = (ehlo.lines.find((l) => /^AUTH\b/i.test(l)) ?? '').toUpperCase().split(/[\s=]+/);
			const password = o.password ?? '';
			if (auth.includes('PLAIN'))
				await replies.expect([235], `AUTH PLAIN ${b64(`\0${o.user}\0${password}`)}`);
			else if (auth.includes('LOGIN')) {
				await replies.expect([334], 'AUTH LOGIN');
				await replies.expect([334], b64(o.user));
				await replies.expect([235], b64(password));
			} else throw new Error('The mail server offers no sign-in this app supports.');
		}
		await replies.expect([250], `MAIL FROM:<${o.from}>`);
		await replies.expect([250, 251], `RCPT TO:<${o.to}>`);
		await replies.expect([354], 'DATA');
		// Lines starting with a dot get another one (RFC 5321 4.5.2).
		await replies.expect([250], `${mailMessage(o).replace(/^\./gm, '..')}\r\n.`);
		await replies.expect([221], 'QUIT').catch(() => {});
		return 'Delivered.';
	} catch (error) {
		const e = error as NodeJS.ErrnoException;
		if (e.code && /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET)$/.test(e.code))
			throw new Error(`Could not reach the mail server (${e.code}).`, { cause: error });
		if (e.code?.startsWith('ERR_TLS') || /certificate/i.test(e.message))
			throw new Error(`The mail server's certificate was not accepted: ${e.message}`, {
				cause: error
			});
		throw error;
	} finally {
		o.signal.removeEventListener('abort', abort);
		socket.destroy();
	}
}
