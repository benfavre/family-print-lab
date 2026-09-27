// Input checks for home automation: plugs, and the module's settings (stored in meta through
// ctx.settings). Secrets are write-only: on a patch, a missing or empty password/token keeps the stored
// one and null clears it.
import { z } from 'zod';
import { PLUG_KINDS } from '$lib/shared/home-automation';

const httpUrl = z
	.string()
	.trim()
	.max(500)
	.refine(
		(u) => /^https?:\/\/[^/\s]/i.test(u) && URL.canParse(u),
		'Use an address that starts with http:// or https://'
	);
const secret = z.string().max(500).nullable();

export const plugConfigInput = z.strictObject({
	url: httpUrl.optional(),
	user: z.string().trim().max(100).optional(),
	password: secret.optional(),
	channel: z.number().int().min(0).max(15).optional(),
	entityId: z
		.string()
		.trim()
		.regex(/^[a-z_]+\.[a-z0-9_]+$/, 'Use an entity id like switch.printer_plug')
		.optional(),
	token: secret.optional(),
	onUrl: httpUrl.optional(),
	offUrl: httpUrl.optional(),
	method: z.enum(['GET', 'POST']).optional()
});
export type PlugConfigInput = z.infer<typeof plugConfigInput>;

/** What is stored in plugs.config (secrets included). */
export interface PlugConfig {
	url?: string;
	user?: string;
	password?: string;
	channel?: number;
	entityId?: string;
	token?: string;
	onUrl?: string;
	offUrl?: string;
	method?: 'GET' | 'POST';
}

const rules = {
	autoOn: z.boolean().optional(),
	autoOff: z.boolean().optional(),
	cooldownMinutes: z.number().int().min(0).max(240).optional(),
	offBelowNozzle: z.number().int().min(30).max(120).optional()
};

export const plugInput = z.strictObject({
	printerId: z.string().min(1).max(80),
	kind: z.enum(PLUG_KINDS),
	config: plugConfigInput,
	...rules
});

export const plugPatch = z.strictObject({
	version: z.number().int().min(1),
	kind: z.enum(PLUG_KINDS).optional(),
	config: plugConfigInput.optional(),
	...rules
});

export const powerInput = z.strictObject({ on: z.boolean() });

const topicPath = z
	.string()
	.trim()
	.min(1)
	.max(100)
	.regex(/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/, 'Letters, digits, - and _ separated by /');
const mqttUrl = z
	.string()
	.trim()
	.max(300)
	.refine(
		(u) => u === '' || (/^mqtts?:\/\/[^/\s]/i.test(u) && URL.canParse(u)),
		'Use an address like mqtt://192.168.1.10:1883 or mqtts://broker.local:8883'
	);

/** Stored settings (meta settings:home-automation). */
export const storedSettings = z.object({
	tokenHash: z.string().nullable(),
	tokenCreatedAt: z.string().nullable(),
	ha: z.object({ enabled: z.boolean() }),
	metrics: z.object({ enabled: z.boolean() }),
	mqtt: z.object({
		enabled: z.boolean(),
		url: mqttUrl,
		username: z.string().max(200),
		password: z.string().max(500),
		topicPrefix: topicPath,
		discovery: z.boolean(),
		discoveryPrefix: topicPath,
		verifyTls: z.boolean()
	})
});
export type StoredSettings = z.infer<typeof storedSettings>;

export const DEFAULT_SETTINGS: StoredSettings = {
	tokenHash: null,
	tokenCreatedAt: null,
	ha: { enabled: false },
	metrics: { enabled: false },
	mqtt: {
		enabled: false,
		url: '',
		username: '',
		password: '',
		topicPrefix: 'printlab',
		discovery: false,
		discoveryPrefix: 'homeassistant',
		verifyTls: true
	}
};

export const mqttInput = z.strictObject({
	enabled: z.boolean().optional(),
	url: mqttUrl.optional(),
	username: z.string().trim().max(200).optional(),
	password: secret.optional(),
	topicPrefix: topicPath.optional(),
	discovery: z.boolean().optional(),
	discoveryPrefix: topicPath.optional(),
	verifyTls: z.boolean().optional()
});

export const settingsPatch = z.strictObject({
	ha: z.strictObject({ enabled: z.boolean() }).optional(),
	metrics: z.strictObject({ enabled: z.boolean() }).optional(),
	mqtt: mqttInput.optional()
});
