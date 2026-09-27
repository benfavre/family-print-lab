// Notifications: the centre behind the bell, desktop notifications in the Electron app, and opt-in
// channels (ntfy, webhook, Discord, Telegram, email). Listens to every bus event and tells the ones
// in the catalogue (shared/notifications.ts); other packages call notify() through NotifyService.
import { defineModule, type ModuleContext } from '../../modules';
import type { CameraService, HmsService, NotifyService } from '../contracts';
import type {
	DeliveryResult,
	NotificationList,
	NotificationSettingsView
} from '$lib/shared/notifications';
import { hmsSeverity, type Lookups } from './messages';
import { LIVE_CHANNEL, Notifier, type DesktopBridge } from './notifier';
import { applyInput, DEFAULT_SETTINGS, mergeChannel, settingsView } from './settings';
import { readInput, storedSettings, testInput } from './validation';
import { parse } from '../../validation';

export interface NotificationsService extends NotifyService {
	list(o?: { limit?: number; before?: string }): NotificationList;
	markRead(input: unknown): NotificationList;
	clear(): NotificationList;
	settings(): NotificationSettingsView;
	saveSettings(input: unknown): NotificationSettingsView;
	/** Sends a test message to a channel as the browser has it (saved secrets filled in). */
	test(input: unknown): Promise<DeliveryResult>;
	/** Waits for deliveries in flight (tests). */
	idle(): Promise<void>;
}

declare module '../../modules' {
	interface ModuleServices {
		notifications: NotificationsService;
	}
}

const desktop = () =>
	(globalThis as typeof globalThis & { printLabDesktop?: DesktopBridge }).printLabDesktop;

let current: { channels: () => number } | null = null;
let stopping: (() => void) | null = null;

export default defineModule({
	key: 'notifications',
	order: 150,
	start(ctx): NotificationsService {
		const store = ctx.settings(storedSettings, DEFAULT_SETTINGS);
		const sql = ctx.db.$client;
		const kidTitle = (row: { title: string; name: string; kid: string | null } | undefined) =>
			row ? { title: row.title, kid: row.kid ? row.name : null } : null;
		const lookups: Lookups = {
			printerName: (id) => ctx.printers.info().find((p) => p.id === id)?.name ?? null,
			printerState(id) {
				try {
					const s = ctx.printers.statusOf(id).state;
					return s ? { task: s.task, percent: s.percent } : null;
				} catch {
					return null;
				}
			},
			job: (id) =>
				kidTitle(
					sql
						.prepare(
							`SELECT p.title, f.name, f.kid FROM jobs j JOIN projects p ON p.id = j.project_id JOIN profiles f ON f.id = p.profile_id WHERE j.id = ?`
						)
						.get(id) as never
				),
			project: (id) =>
				kidTitle(
					sql
						.prepare(
							`SELECT p.title, f.name, f.kid FROM projects p JOIN profiles f ON f.id = p.profile_id WHERE p.id = ?`
						)
						.get(id) as never
				),
			profile: (id) =>
				(sql.prepare(`SELECT name FROM profiles WHERE id = ?`).get(id) as { name: string }) ?? null,
			hms(code, printerId) {
				try {
					const info = optional<HmsService>(ctx, 'hms')?.describe(code, printerId);
					if (info) return { text: info.text, severity: info.severity };
				} catch {
					/* fall back to the code */
				}
				return { text: '', severity: hmsSeverity(code) };
			},
			printError(code, printerId) {
				try {
					const text = optional<HmsService>(ctx, 'hms')?.describe(code, printerId).text;
					if (text) return text;
				} catch {
					/* fall back to the code */
				}
				return `Error ${(code >>> 0).toString(16).toUpperCase().padStart(8, '0')}.`;
			}
		};
		const notifier = new Notifier({
			db: ctx.db,
			settings: store,
			live: ctx.live,
			lookups,
			desktop,
			camera: () => optional<CameraService>(ctx, 'camera'),
			log: ctx.log,
			origin: ctx.env.ORIGIN?.replace(/\/+$/, '') || null
		});
		const off = ctx.bus.onAny((e) =>
			notifier.handle(e.name, e.data as unknown as Record<string, unknown>)
		);
		const list = (o: { limit?: number; before?: string } = {}): NotificationList => ({
			items: notifier.store.list(o),
			unread: notifier.store.unread()
		});
		const changed = () => {
			const l = list();
			ctx.live.send(LIVE_CHANNEL, { unread: l.unread });
			return l;
		};
		const view = () =>
			settingsView(store.get(), {
				last: notifier.last,
				desktopAvailable: !!desktop(),
				modules: moduleKeys(ctx)
			});
		current = {
			channels: () => store.get().channels.filter((c) => c.enabled).length
		};
		stopping = () => {
			off();
			notifier.stop();
		};
		return {
			notify: (m) => notifier.notify(m),
			list,
			markRead(input) {
				const r = parse(readInput, input);
				notifier.store.markRead('all' in r ? 'all' : r.ids);
				return changed();
			},
			clear() {
				notifier.store.clear();
				return changed();
			},
			settings: view,
			saveSettings(input) {
				store.set(applyInput(input, store.get()));
				return view();
			},
			test(input) {
				const { channel } = parse(testInput, input);
				const saved = store.get().channels.find((c) => c.id === channel.id);
				return notifier.test(mergeChannel(channel, saved));
			},
			idle: () => notifier.idle()
		};
	},
	stop() {
		stopping?.();
		stopping = null;
		current = null;
	},
	integrations() {
		const on = current?.channels() ?? 0;
		return [
			{
				id: 'notifications',
				kind: 'module',
				name: 'Notifications',
				via: 'The bell, this computer, ntfy, webhooks, Discord, Telegram, email',
				available: true,
				detail: on
					? `${on} channel${on === 1 ? '' : 's'} on, plus the bell.`
					: 'The bell in the top bar only. Add a channel to hear about prints elsewhere.',
				powers: ['Print finished, failed or paused', 'Printer alerts', 'Kids asking to print'],
				setup: [{ text: 'Integrations → Notifications: add a channel, then press Test.' }]
			}
		];
	}
});

/** Keys of the packages present (for events that only some packages emit). */
function moduleKeys(ctx: ModuleContext): string[] {
	return ['queue', 'maintenance', 'ai-vision'].filter((k) => !!optional(ctx, k));
}

/** Another package's service, which may be absent (its ModuleServices entry comes with it). */
function optional<T>(ctx: ModuleContext, key: string): T | undefined {
	return (ctx.module as (key: string) => unknown)(key) as T | undefined;
}
