// Each HTTP channel's request, as a local fake server receives it.
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeServer } from '../testing';
import { encodeWords, sendHttp, sign, type Delivery } from './http';
import { storedChannel, type StoredChannel } from '../validation';

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
	for (const s of servers.splice(0)) await s.close();
});
async function server(...a: Parameters<typeof fakeServer>) {
	const s = await fakeServer(...a);
	servers.push(s);
	return s;
}

const delivery = (over: Partial<Delivery> = {}): Delivery => ({
	event: 'print.failed',
	level: 'error',
	title: 'Rocket failed',
	body: 'X2D stopped: the nozzle clogged.',
	link: '/printers/p1',
	url: null,
	at: '2026-09-27T10:00:00.000Z',
	data: { printerId: 'p1', task: 'Rocket' },
	picture: null,
	...over
});
const channel = (c: Record<string, unknown>) =>
	storedChannel.parse({ id: 'c1', events: ['print.failed'], ...c }) as StoredChannel;
const opts = (telegramApi = 'http://127.0.0.1:1') => ({
	fetch,
	signal: AbortSignal.timeout(5000),
	telegramApi
});
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

describe('ntfy', () => {
	it('POSTs the text to <server>/<topic> with title, priority, tags and the token', async () => {
		const s = await server();
		const c = channel({ kind: 'ntfy', server: `${s.url}/`, topic: 'lab-x7f3', token: 'tk_secret' });
		expect(
			await sendHttp(c as never, delivery({ url: 'http://lab.local/printers/p1' }), opts())
		).toBe('Delivered.');
		const [r] = s.received;
		expect(r.method).toBe('POST');
		expect(r.url).toBe('/lab-x7f3');
		expect(r.body.toString()).toBe('X2D stopped: the nozzle clogged.');
		expect(r.headers['x-title']).toBe('Rocket failed');
		expect(r.headers['x-priority']).toBe('high');
		expect(r.headers['x-tags']).toBe('x');
		expect(r.headers['x-click']).toBe('http://lab.local/printers/p1');
		expect(r.headers.authorization).toBe('Bearer tk_secret');
	});

	it('PUTs a picture with the text in X-Message, encoding non-ASCII headers', async () => {
		const s = await server();
		const c = channel({ kind: 'ntfy', server: s.url, topic: 'lab' });
		await sendHttp(c as never, delivery({ title: 'Fusée ratée', picture: JPEG }), opts());
		const [r] = s.received;
		expect(r.method).toBe('PUT');
		expect(r.body.equals(JPEG)).toBe(true);
		expect(r.headers['x-filename']).toBe('snapshot.jpg');
		expect(r.headers['x-message']).toBe('X2D stopped: the nozzle clogged.');
		expect(r.headers['x-title']).toBe(
			`=?UTF-8?B?${Buffer.from('Fusée ratée').toString('base64')}?=`
		);
		expect(r.headers.authorization).toBeUndefined();
	});

	it('says what the server answered when it refuses', async () => {
		const s = await server(() => ({ status: 403, body: { code: 40301, error: 'forbidden' } }));
		const c = channel({ kind: 'ntfy', server: s.url, topic: 'lab' });
		await expect(sendHttp(c as never, delivery(), opts())).rejects.toThrow(
			'The server answered 403: forbidden'
		);
	});
});

describe('generic webhook', () => {
	it('POSTs { event, at, data } signed with an HMAC of the exact body', async () => {
		const s = await server();
		const c = channel({ kind: 'webhook', url: `${s.url}/hook`, secret: 'shh' });
		await sendHttp(c as never, delivery(), opts());
		const [r] = s.received;
		const body = JSON.parse(r.body.toString());
		expect(body).toMatchObject({
			event: 'print.failed',
			at: '2026-09-27T10:00:00.000Z',
			data: { printerId: 'p1', task: 'Rocket' },
			message: { title: 'Rocket failed', level: 'error' }
		});
		const expected = createHmac('sha256', 'shh').update(r.body).digest('hex');
		expect(r.headers['x-printlab-signature']).toBe(`sha256=${expected}`);
		expect(sign('shh', r.body.toString())).toBe(`sha256=${expected}`);
	});

	it('sends no signature without a secret', async () => {
		const s = await server();
		await sendHttp(channel({ kind: 'webhook', url: s.url }) as never, delivery(), opts());
		expect(s.received[0].headers['x-printlab-signature']).toBeUndefined();
	});
});

describe('Discord', () => {
	it('POSTs an embed with mentions switched off', async () => {
		const s = await server(() => ({ status: 204, body: '' }));
		await sendHttp(
			channel({ kind: 'discord', url: `${s.url}/api/webhooks/1/abc` }) as never,
			delivery(),
			opts()
		);
		const body = JSON.parse(s.received[0].body.toString());
		expect(body.allowed_mentions).toEqual({ parse: [] });
		expect(body.embeds[0]).toMatchObject({
			title: 'Rocket failed',
			description: 'X2D stopped: the nozzle clogged.',
			timestamp: '2026-09-27T10:00:00.000Z'
		});
	});

	it('sends a picture as multipart payload_json + files[0]', async () => {
		const s = await server();
		await sendHttp(
			channel({ kind: 'discord', url: s.url }) as never,
			delivery({ picture: JPEG }),
			opts()
		);
		const r = s.received[0];
		expect(r.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
		const text = r.body.toString('latin1');
		expect(text).toContain('name="payload_json"');
		expect(text).toContain('attachment://snapshot.jpg');
		expect(text).toContain('name="files[0]"; filename="snapshot.jpg"');
	});
});

describe('Telegram', () => {
	const token = '123456:ABCdefGHIjklMNOpqrSTUvwxYZ';

	it('calls sendMessage with chat_id and text', async () => {
		const s = await server(() => ({ body: { ok: true, result: {} } }));
		await sendHttp(
			channel({ kind: 'telegram', token, chatId: '-1001234' }) as never,
			delivery(),
			opts(s.url)
		);
		const r = s.received[0];
		expect(r.url).toBe(`/bot${token}/sendMessage`);
		expect(JSON.parse(r.body.toString())).toEqual({
			chat_id: '-1001234',
			text: 'Rocket failed\nX2D stopped: the nozzle clogged.'
		});
	});

	it('uses sendPhoto for a picture and passes Telegram’s refusal on', async () => {
		const s = await server((r) =>
			r.url.endsWith('/sendPhoto')
				? { status: 400, body: { ok: false, description: 'Bad Request: chat not found' } }
				: {}
		);
		await expect(
			sendHttp(
				channel({ kind: 'telegram', token, chatId: '42' }) as never,
				delivery({ picture: JPEG }),
				opts(s.url)
			)
		).rejects.toThrow('chat not found');
		expect(s.received[0].url).toBe(`/bot${token}/sendPhoto`);
		expect(s.received[0].body.toString('latin1')).toContain('name="caption"');
	});

	it('never repeats the address (it holds the token) when the server cannot be reached', async () => {
		const error = await sendHttp(
			channel({ kind: 'telegram', token, chatId: '42' }) as never,
			delivery(),
			opts('http://127.0.0.1:1')
		).catch((e: Error) => e);
		expect(String(error)).toMatch(/Could not reach the server/);
		expect(String(error)).not.toContain(token);
	});
});

describe('header encoding', () => {
	it('keeps ASCII and encodes the rest in short words on character boundaries', () => {
		expect(encodeWords('Plain title')).toBe('Plain title');
		expect(encodeWords('two\nlines')).toBe('two lines');
		const long = 'é'.repeat(40);
		const words = encodeWords(long).split(' ');
		expect(words.length).toBeGreaterThan(1);
		expect(words.map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join('')).toBe(
			long
		);
	});
});
