// The channels that are plain HTTP requests: ntfy, generic webhook, Discord and Telegram. Each builds
// its request from a Delivery (tested against local fake servers) and fails with a short reason.
import { createHmac } from 'node:crypto';
import type { NotifyLevel } from '$lib/shared/notifications';
import type { StoredChannel } from '../validation';

/** One message on its way to one channel. */
export interface Delivery {
	event: string;
	level: NotifyLevel;
	title: string;
	body: string;
	/** In-app path (desktop notifications open it). */
	link: string | null;
	/** Absolute link into the app, only when the app knows its own address (ORIGIN). */
	url: string | null;
	at: string;
	data: Record<string, unknown>;
	/** A JPEG from the printer's camera. */
	picture: Buffer | null;
}

export interface HttpOptions {
	fetch: typeof fetch;
	signal: AbortSignal;
	/** Telegram Bot API base (tests point it at a fake server). */
	telegramApi: string;
}

type Of<K extends StoredChannel['kind']> = Extract<StoredChannel, { kind: K }>;

/** Header values must be ASCII: others become RFC 2047 encoded words, split on characters. */
export function encodeWords(value: string): string {
	const text = value.replace(/[\r\n]+/g, ' ');
	if (/^[\x20-\x7e]*$/.test(text)) return text;
	const words: string[] = [];
	let chunk = '';
	for (const ch of text) {
		if (Buffer.byteLength(chunk + ch) > 45) {
			words.push(chunk);
			chunk = '';
		}
		chunk += ch;
	}
	if (chunk) words.push(chunk);
	return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join(' ');
}

async function failure(res: Response): Promise<Error> {
	let detail = '';
	try {
		const text = await res.text();
		try {
			const json = JSON.parse(text);
			detail = String(json.error ?? json.description ?? json.message ?? '');
		} catch {
			detail = text;
		}
	} catch {
		/* no body */
	}
	detail = detail.replace(/\s+/g, ' ').trim().slice(0, 160);
	return new Error(`The server answered ${res.status}${detail ? `: ${detail}` : '.'}`);
}

// ---------- ntfy (https://docs.ntfy.sh/publish/) ----------

// Priorities 1–5 by name, emoji tags by short code (docs.ntfy.sh/publish "Message priority", "Tags & emojis").
const NTFY_PRIORITY: Record<NotifyLevel, string> = {
	error: 'high',
	warning: 'default',
	success: 'default',
	info: 'low'
};
const NTFY_TAG: Record<NotifyLevel, string> = {
	error: 'x',
	warning: 'warning',
	success: 'white_check_mark',
	info: 'information_source'
};

/**
 * POST <server>/<topic> with the text as body, or PUT with the picture as body and the text in
 * X-Message. Header names from ntfy server/server.go parsePublishParams (x-title, x-message,
 * x-priority, x-tags, x-click, x-filename; values may be RFC 2047 encoded, server/util.go).
 */
export function ntfyRequest(c: Of<'ntfy'>, d: Delivery): { url: string; init: RequestInit } {
	const headers: Record<string, string> = {
		'X-Title': encodeWords(d.title),
		'X-Priority': NTFY_PRIORITY[d.level],
		'X-Tags': NTFY_TAG[d.level]
	};
	if (d.url) headers['X-Click'] = d.url;
	if (c.token) headers.Authorization = `Bearer ${c.token}`;
	const url = `${c.server.replace(/\/+$/, '')}/${c.topic}`;
	if (d.picture) {
		headers['X-Filename'] = 'snapshot.jpg';
		headers['X-Message'] = encodeWords(d.body || d.title);
		return { url, init: { method: 'PUT', headers, body: new Uint8Array(d.picture) } };
	}
	headers['Content-Type'] = 'text/plain; charset=utf-8';
	return { url, init: { method: 'POST', headers, body: d.body || d.title } };
}

// ---------- Generic webhook ----------

/** `sha256=<hex HMAC-SHA256 of the exact body>`, like GitHub's X-Hub-Signature-256. */
export const sign = (secret: string, body: string) =>
	`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

export function webhookRequest(c: Of<'webhook'>, d: Delivery): { url: string; init: RequestInit } {
	const body = JSON.stringify({
		event: d.event,
		at: d.at,
		data: d.data,
		message: { title: d.title, body: d.body, level: d.level, url: d.url }
	});
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		'User-Agent': 'FamilyPrintLab'
	};
	if (c.secret) headers['X-PrintLab-Signature'] = sign(c.secret, body);
	return { url: c.url, init: { method: 'POST', headers, body } };
}

// ---------- Discord (https://discord.com/developers/docs/resources/webhook#execute-webhook) ----------

const DISCORD_COLOUR: Record<NotifyLevel, number> = {
	error: 0xe5484d,
	warning: 0xf5a524,
	success: 0x46a758,
	info: 0x3e8ed0
};

/**
 * JSON `{ content, embeds }` (content up to 2000 characters, embed title 256, description 4096), or
 * multipart with `payload_json` and `files[0]` when a picture goes along, shown in the embed through
 * attachment://. Mentions are switched off so a print name can never ping anyone.
 */
export function discordRequest(c: Of<'discord'>, d: Delivery): { url: string; init: RequestInit } {
	const embed: Record<string, unknown> = {
		title: d.title.slice(0, 256),
		description: d.body.slice(0, 4096),
		color: DISCORD_COLOUR[d.level],
		timestamp: d.at
	};
	if (d.url) embed.url = d.url;
	if (d.picture) embed.image = { url: 'attachment://snapshot.jpg' };
	const payload = { embeds: [embed], allowed_mentions: { parse: [] } };
	if (!d.picture)
		return {
			url: c.url,
			init: {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			}
		};
	const form = new FormData();
	form.set('payload_json', JSON.stringify(payload));
	form.set(
		'files[0]',
		new Blob([new Uint8Array(d.picture)], { type: 'image/jpeg' }),
		'snapshot.jpg'
	);
	return { url: c.url, init: { method: 'POST', body: form } };
}

// ---------- Telegram (https://core.telegram.org/bots/api#sendmessage) ----------

/** sendMessage `{ chat_id, text }` (text up to 4096), or sendPhoto (multipart, caption up to 1024). */
export function telegramRequest(
	c: Of<'telegram'>,
	d: Delivery,
	api: string
): { url: string; init: RequestInit } {
	const text = [d.title, d.body, d.url].filter(Boolean).join('\n');
	const base = `${api.replace(/\/+$/, '')}/bot${c.token}`;
	if (!d.picture)
		return {
			url: `${base}/sendMessage`,
			init: {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ chat_id: c.chatId, text: text.slice(0, 4096) })
			}
		};
	const form = new FormData();
	form.set('chat_id', c.chatId);
	form.set('caption', text.slice(0, 1024));
	form.set('photo', new Blob([new Uint8Array(d.picture)], { type: 'image/jpeg' }), 'snapshot.jpg');
	return { url: `${base}/sendPhoto`, init: { method: 'POST', body: form } };
}

/** Sends one HTTP channel's request; resolves with a short success note. */
export async function sendHttp(
	c: Exclude<StoredChannel, { kind: 'desktop' | 'email' }>,
	d: Delivery,
	o: HttpOptions
): Promise<string> {
	const { url, init } =
		c.kind === 'ntfy'
			? ntfyRequest(c, d)
			: c.kind === 'webhook'
				? webhookRequest(c, d)
				: c.kind === 'discord'
					? discordRequest(c, d)
					: telegramRequest(c, d, o.telegramApi);
	let res: Response;
	try {
		res = await o.fetch(url, { ...init, signal: o.signal, redirect: 'error' });
	} catch (error) {
		// Never repeat the URL: Discord and Telegram carry their secret in it.
		const cause = (error as { cause?: { code?: string } }).cause?.code;
		throw new Error(
			(error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError'
				? 'No answer in time.'
				: `Could not reach the server${cause ? ` (${cause})` : ''}.`,
			{ cause: error }
		);
	}
	if (!res.ok) throw await failure(res);
	if (c.kind === 'telegram') {
		const json = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
		if (json.ok === false) throw new Error(json.description ?? 'Telegram refused the message.');
	} else await res.body?.cancel().catch(() => {});
	return 'Delivered.';
}
