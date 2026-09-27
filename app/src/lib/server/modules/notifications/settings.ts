// Notification settings: defaults, the browser's view (no secrets, only hasToken and friends), and
// saving what the browser sends (a missing or empty secret keeps the saved one, null removes it).
import {
	eventDef,
	NOTIFY_EVENTS,
	type ChannelView,
	type DeliveryResult,
	type NotificationSettingsView,
	type Template
} from '$lib/shared/notifications';
import { AppError, parse } from '../../validation';
import {
	SECRET_FIELDS,
	settingsInput,
	storedChannel,
	storedSettings,
	type StoredChannel,
	type StoredSettings
} from './validation';

export const DEFAULT_SETTINGS: StoredSettings = {
	inApp: NOTIFY_EVENTS.map((e) => e.name),
	templates: {},
	kidPictures: false,
	channels: []
};

export function channelView(c: StoredChannel, last: DeliveryResult | null): ChannelView {
	const common = {
		id: c.id,
		name: c.name,
		enabled: c.enabled,
		events: c.events,
		quiet: c.quiet,
		snapshots: c.snapshots,
		hmsSeverity: c.hmsSeverity,
		last
	};
	switch (c.kind) {
		case 'desktop':
			return { ...common, kind: 'desktop' };
		case 'ntfy':
			return { ...common, kind: 'ntfy', server: c.server, topic: c.topic, hasToken: !!c.token };
		case 'webhook':
			return { ...common, kind: 'webhook', url: c.url, hasSecret: !!c.secret };
		case 'discord':
			return { ...common, kind: 'discord', hasUrl: !!c.url };
		case 'telegram':
			return { ...common, kind: 'telegram', chatId: c.chatId, hasToken: !!c.token };
		case 'email':
			return {
				...common,
				kind: 'email',
				host: c.host,
				port: c.port,
				security: c.security,
				user: c.user,
				from: c.from,
				to: c.to,
				hasPassword: !!c.password
			};
	}
}

export function settingsView(
	s: StoredSettings,
	o: { last: Map<string, DeliveryResult>; desktopAvailable: boolean; modules: string[] }
): NotificationSettingsView {
	return {
		inApp: s.inApp,
		templates: s.templates,
		kidPictures: s.kidPictures,
		channels: s.channels.map((c) => channelView(c, o.last.get(c.id) ?? null)),
		desktopAvailable: o.desktopAvailable,
		present: NOTIFY_EVENTS.filter((e) => !e.module || o.modules.includes(e.module)).map(
			(e) => e.name
		)
	};
}

/** A channel from the browser, with its saved secrets filled in where the browser left them out. */
export function mergeChannel(
	input: Record<string, unknown>,
	saved: StoredChannel | undefined
): StoredChannel {
	const kind = String(input.kind ?? '');
	const out: Record<string, unknown> = { ...input };
	for (const field of SECRET_FIELDS[kind] ?? []) {
		const value = input[field];
		if (value === undefined || value === '')
			out[field] = saved?.kind === kind ? (saved as Record<string, unknown>)[field] : undefined;
	}
	// Leave hasToken & co. out: they are the view's, not settings.
	for (const k of ['hasToken', 'hasSecret', 'hasUrl', 'hasPassword', 'last']) delete out[k];
	if (kind === 'discord' && !out.url) throw new AppError(400, 'Paste the Discord webhook address.');
	if (kind === 'telegram' && !out.token) throw new AppError(400, 'Paste the Telegram bot token.');
	return parse(storedChannel, out);
}

/** Validates the browser's settings against what is saved and returns what to store. */
export function applyInput(input: unknown, saved: StoredSettings): StoredSettings {
	const next = parse(settingsInput, input);
	const ids = new Set<string>();
	let desktops = 0;
	const channels = next.channels.map((raw) => {
		const channel = mergeChannel(
			raw,
			saved.channels.find((c) => c.id === raw.id)
		);
		if (ids.has(channel.id)) throw new AppError(400, 'Two channels have the same id.');
		if (channel.kind === 'desktop' && ++desktops > 1)
			throw new AppError(400, 'There is only one “This computer” channel.');
		ids.add(channel.id);
		return channel;
	});
	// Only edited templates are kept, so improved defaults reach everyone else.
	const templates: Record<string, Template> = {};
	for (const [name, t] of Object.entries(next.templates)) {
		const def = eventDef(name)?.template;
		if (!def || (!t.title.trim() && !t.body.trim())) continue;
		if (t.title === def.title && t.body === def.body) continue;
		templates[name] = { title: t.title.trim(), body: t.body.trim() };
	}
	return parse(storedSettings, {
		inApp: next.inApp,
		templates,
		kidPictures: next.kidPictures,
		channels
	});
}
