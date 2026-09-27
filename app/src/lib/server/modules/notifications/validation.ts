// Notification settings as stored (with secrets) and as the browser sends them (secrets optional:
// left out or empty keeps the saved one, null removes it).
import { z } from 'zod';
import { DEFAULT_NTFY_SERVER, DEFAULT_QUIET, HMS_SEVERITIES } from '$lib/shared/notifications';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 22:00.');
const httpUrl = z
	.string()
	.trim()
	.max(500)
	.refine((u) => {
		try {
			return ['http:', 'https:'].includes(new URL(u).protocol);
		} catch {
			return false;
		}
	}, 'Enter a full web address starting with https://.');
const eventName = z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/);

const common = {
	id: z.string().regex(/^[a-z0-9-]{1,40}$/),
	name: z.string().trim().max(60).default(''),
	enabled: z.boolean().default(true),
	events: z.array(eventName).max(50).default([]),
	quiet: z.object({ enabled: z.boolean(), from: hhmm, to: hhmm }).default({ ...DEFAULT_QUIET }),
	snapshots: z.boolean().default(false),
	hmsSeverity: z.enum(HMS_SEVERITIES).default('serious')
};

/** ntfy topics: letters, digits, - and _ (ntfy server/server.go topicRegex), at most 64. */
const topic = z.string().regex(/^[-_A-Za-z0-9]{1,64}$/, 'Use letters, digits, - or _ only.');
const secret = z.string().max(500);
const telegramToken = z.string().regex(/^\d+:[\w-]{20,}$/, 'That does not look like a bot token.');
const telegramChat = z
	.string()
	.trim()
	.regex(/^(-?\d{1,20}|@[A-Za-z]\w{3,63})$/, 'Use the chat id (a number) or @channelname.');
const email = z.string().trim().max(200).pipe(z.email('Enter an email address.'));
const host = z
	.string()
	.trim()
	.regex(/^[A-Za-z0-9.-]{1,253}$/, 'Enter a server name like smtp.example.com.');

/** Stored channel (secrets included). */
export const storedChannel = z.discriminatedUnion('kind', [
	z.object({ ...common, kind: z.literal('desktop') }),
	z.object({
		...common,
		kind: z.literal('ntfy'),
		server: httpUrl.default(DEFAULT_NTFY_SERVER),
		topic,
		token: secret.nullable().default(null)
	}),
	z.object({
		...common,
		kind: z.literal('webhook'),
		url: httpUrl,
		secret: secret.nullable().default(null)
	}),
	z.object({ ...common, kind: z.literal('discord'), url: httpUrl }),
	z.object({ ...common, kind: z.literal('telegram'), token: telegramToken, chatId: telegramChat }),
	z.object({
		...common,
		kind: z.literal('email'),
		host,
		port: z.number().int().min(1).max(65535),
		security: z.enum(['tls', 'starttls']),
		user: z.string().trim().max(200).default(''),
		password: secret.nullable().default(null),
		from: email,
		to: email
	})
]);
export type StoredChannel = z.infer<typeof storedChannel>;

const template = z.object({ title: z.string().max(120), body: z.string().max(500) });

export const storedSettings = z.object({
	inApp: z.array(eventName).max(50),
	templates: z.record(eventName, template),
	kidPictures: z.boolean(),
	channels: z.array(storedChannel).max(12)
});
export type StoredSettings = z.infer<typeof storedSettings>;

/** What the browser sends: the settings, with secret fields optional. */
export const settingsInput = z.object({
	inApp: z.array(eventName).max(50),
	templates: z.record(eventName, template).default({}),
	kidPictures: z.boolean().default(false),
	channels: z.array(z.record(z.string(), z.unknown())).max(12)
});

export const readInput = z.union([
	z.object({ all: z.literal(true) }),
	z.object({ ids: z.array(z.string().max(64)).min(1).max(500) })
]);

export const testInput = z.object({ channel: z.record(z.string(), z.unknown()) });

/** Secret fields per kind (write-only in the API). */
export const SECRET_FIELDS: Record<string, string[]> = {
	ntfy: ['token'],
	webhook: ['secret'],
	discord: ['url'],
	telegram: ['token'],
	email: ['password']
};
