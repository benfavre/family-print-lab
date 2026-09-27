// The SMTP client against a fake mail server: STARTTLS then AUTH PLAIN, implicit TLS with AUTH LOGIN,
// and the refusals (no STARTTLS offered, wrong password).
import net from 'node:net';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasOpenssl, testCa } from '../../../testing/certs';
import { sendMail, type MailOptions } from './email';

const openssl = hasOpenssl();
let ca: ReturnType<typeof testCa>;
let leaf: { key: string; cert: string };
beforeAll(() => {
	if (!openssl) return;
	ca = testCa();
	leaf = ca.leaf('localhost');
});
afterAll(() => ca?.cleanup());

interface Session {
	commands: string[];
	data: string;
}

/** A tiny SMTP server: offers STARTTLS (or not), the AUTH mechanisms given, and records the mail. */
async function fakeSmtp(o: {
	implicit?: boolean;
	starttls?: boolean;
	auth: string;
	password: string;
	/** Sends one more reply in the same packet as STARTTLS's 220 (a response injection). */
	inject?: string;
}) {
	const sessions: Session[] = [];
	const serve = (socket: net.Socket) => {
		const s: Session = { commands: [], data: '' };
		sessions.push(s);
		let buf = '';
		let inData = false;
		let login: 'user' | 'pass' | null = null;
		let secure = !!o.implicit;
		const reply = (line: string) => socket.write(`${line}\r\n`);
		const onData = (chunk: Buffer) => {
			buf += chunk.toString('utf8');
			let at: number;
			while ((at = buf.indexOf('\r\n')) >= 0) {
				const line = buf.slice(0, at);
				buf = buf.slice(at + 2);
				if (inData) {
					if (line === '.') {
						inData = false;
						reply('250 2.0.0 Queued');
					} else s.data += `${line}\n`;
					continue;
				}
				if (login) {
					s.commands.push(`${login}:${Buffer.from(line, 'base64').toString()}`);
					if (login === 'user') {
						login = 'pass';
						reply('334 UGFzc3dvcmQ6');
					} else {
						login = null;
						reply(
							Buffer.from(line, 'base64').toString() === o.password
								? '235 2.7.0 Accepted'
								: '535 5.7.8 Authentication failed'
						);
					}
					continue;
				}
				s.commands.push(line);
				const verb = line.split(' ')[0].toUpperCase();
				if (verb === 'EHLO') {
					reply('250-fake.smtp greets you');
					if (o.starttls && !secure) reply('250-STARTTLS');
					if (secure || !o.starttls) reply(`250-AUTH ${o.auth}`);
					reply('250 8BITMIME');
				} else if (verb === 'STARTTLS') {
					if (o.inject) socket.write(`220 2.0.0 Ready to start TLS\r\n${o.inject}\r\n`);
					else reply('220 2.0.0 Ready to start TLS');
					socket.off('data', onData);
					const upgraded = new tls.TLSSocket(socket, { isServer: true, ...leaf });
					secure = true;
					upgraded.on('data', onData);
					upgraded.on('error', () => {});
					socket = upgraded;
				} else if (verb === 'AUTH' && line.split(' ')[1] === 'PLAIN') {
					const [, user, pass] = Buffer.from(line.split(' ')[2], 'base64').toString().split('\0');
					s.commands.push(`plain:${user}`);
					reply(pass === o.password ? '235 2.7.0 Accepted' : '535 5.7.8 Authentication failed');
				} else if (verb === 'AUTH' && line.split(' ')[1] === 'LOGIN') {
					login = 'user';
					reply('334 VXNlcm5hbWU6');
				} else if (verb === 'MAIL' || verb === 'RCPT') reply('250 2.1.0 Ok');
				else if (verb === 'DATA') {
					inData = true;
					reply('354 End data with <CR><LF>.<CR><LF>');
				} else if (verb === 'QUIT') {
					reply('221 2.0.0 Bye');
					socket.end();
				} else reply('502 5.5.2 Command not recognized');
			}
		};
		socket.on('data', onData);
		socket.on('error', () => {});
		reply('220 fake.smtp ESMTP');
	};
	const server = o.implicit
		? tls.createServer({ ...leaf }, serve)
		: net.createServer((socket) => serve(socket));
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return {
		port: (server.address() as AddressInfo).port,
		sessions,
		close: () => new Promise<void>((resolve) => server.close(() => resolve()))
	};
}

const mail = (port: number, over: Partial<MailOptions> = {}): MailOptions => ({
	host: 'localhost',
	port,
	security: 'starttls',
	user: 'lab@example.com',
	password: 'hunter22',
	from: 'lab@example.com',
	to: 'parent@example.com',
	subject: 'Rocket is done',
	text: 'X2D finished printing Rocket.\n.hidden line',
	picture: null,
	signal: AbortSignal.timeout(5000),
	tls: { ca: ca.ca },
	...over
});

describe.skipIf(!openssl)('email over SMTP', () => {
	it('upgrades with STARTTLS, signs in with AUTH PLAIN and sends a base64 message', async () => {
		const smtp = await fakeSmtp({ starttls: true, auth: 'PLAIN LOGIN', password: 'hunter22' });
		try {
			expect(await sendMail(mail(smtp.port))).toBe('Delivered.');
			const [s] = smtp.sessions;
			expect(s.commands).toEqual([
				'EHLO localhost',
				'STARTTLS',
				'EHLO localhost',
				expect.stringMatching(/^AUTH PLAIN /),
				'plain:lab@example.com',
				'MAIL FROM:<lab@example.com>',
				'RCPT TO:<parent@example.com>',
				'DATA',
				'QUIT'
			]);
			expect(s.data).toContain('Subject: Rocket is done');
			expect(s.data).toContain('To: <parent@example.com>');
			const body = s.data.split('\n\n')[1].replace(/\n/g, '');
			expect(Buffer.from(body, 'base64').toString()).toBe(
				'X2D finished printing Rocket.\n.hidden line'
			);
		} finally {
			await smtp.close();
		}
	});

	it('uses implicit TLS and AUTH LOGIN, and attaches a picture', async () => {
		const smtp = await fakeSmtp({ implicit: true, auth: 'LOGIN', password: 'hunter22' });
		try {
			await sendMail(
				mail(smtp.port, { security: 'tls', picture: Buffer.from('jpeg'), subject: 'Fusée' })
			);
			const [s] = smtp.sessions;
			expect(s.commands).toContain('user:lab@example.com');
			expect(s.commands).toContain('pass:hunter22');
			expect(s.data).toContain('Content-Type: multipart/mixed');
			expect(s.data).toContain('filename="snapshot.jpg"');
			expect(s.data).toContain(`Subject: =?UTF-8?B?${Buffer.from('Fusée').toString('base64')}?=`);
		} finally {
			await smtp.close();
		}
	});

	it('never signs in without STARTTLS, and says when the password is wrong', async () => {
		const plain = await fakeSmtp({ starttls: false, auth: 'PLAIN', password: 'x' });
		const wrong = await fakeSmtp({ starttls: true, auth: 'PLAIN', password: 'other' });
		try {
			await expect(sendMail(mail(plain.port))).rejects.toThrow('does not offer STARTTLS');
			expect(plain.sessions[0].commands.some((c) => c.startsWith('AUTH'))).toBe(false);
			await expect(sendMail(mail(wrong.port))).rejects.toThrow(
				'did not accept the user name or password'
			);
		} finally {
			await plain.close();
			await wrong.close();
		}
	});

	it('refuses replies sent in plain text after STARTTLS', async () => {
		const smtp = await fakeSmtp({
			starttls: true,
			auth: 'PLAIN',
			password: 'hunter22',
			inject: '250-fake.smtp\r\n250 AUTH PLAIN'
		});
		try {
			await expect(sendMail(mail(smtp.port))).rejects.toThrow('sent more before STARTTLS');
			expect(smtp.sessions[0].commands.some((c) => c.startsWith('AUTH'))).toBe(false);
		} finally {
			await smtp.close();
		}
	});

	it('refuses a certificate it does not trust', async () => {
		const smtp = await fakeSmtp({ starttls: true, auth: 'PLAIN', password: 'hunter22' });
		try {
			await expect(sendMail(mail(smtp.port, { tls: {} }))).rejects.toThrow(/certificate/);
		} finally {
			await smtp.close();
		}
	});
});
