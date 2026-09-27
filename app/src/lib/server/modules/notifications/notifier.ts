// The notifier: lab events and NotifyService messages → the centre (a row and a live update), this
// computer's desktop notifications and the opt-in channels. Deliveries run in the background (never
// blocking the bus), each with a timeout, and the last result per channel is kept for Settings.
import type tls from 'node:tls';
import type { DB } from '../../db';
import type { LivePublisher } from '../../modules';
import type { SettingsStore } from '../../module-settings';
import type { CameraService, NotifyService } from '../contracts';
import { eventDef, type DeliveryResult, type NotificationItem } from '$lib/shared/notifications';
import { buildMessage, type Lookups, type Message } from './messages';
import { toggleName, wants, wantsPicture } from './routing';
import { NotificationStore } from './store';
import { sendHttp, type Delivery } from './channels/http';
import { sendMail } from './channels/email';
import type { StoredChannel, StoredSettings } from './validation';

/** What desktop/main.cjs puts on globalThis before it loads the server. */
export interface DesktopBridge {
	notify(title: string, body: string, link: string | null): void;
}

export const LIVE_CHANNEL = 'notifications:changed';
/** The same alert again within this time is told once. */
const DEDUPE_MS = 10 * 60_000;

export interface NotifierOptions {
	db: DB;
	settings: SettingsStore<StoredSettings>;
	live: LivePublisher;
	lookups: Lookups;
	desktop: () => DesktopBridge | undefined;
	camera: () => CameraService | undefined;
	log: (message: string) => void;
	/** The app's own address (ORIGIN), for links in messages; none means no links. */
	origin?: string | null;
	fetch?: typeof fetch;
	telegramApi?: string;
	/** Extra TLS options for email (tests pass their CA). */
	mailTls?: tls.ConnectionOptions;
	/** printer.offline is told this long after the event (the manager already waited 10 s). */
	offlineDelayMs?: number;
	timeoutMs?: number;
	now?: () => Date;
}

export class Notifier implements NotifyService {
	readonly store: NotificationStore;
	readonly last = new Map<string, DeliveryResult>();
	private offline = new Map<string, NodeJS.Timeout>();
	private told = new Map<string, number>();
	private pending = new Set<Promise<unknown>>();
	private stopper = new AbortController();

	constructor(private o: NotifierOptions) {
		this.store = new NotificationStore(o.db);
	}

	private now() {
		return this.o.now?.() ?? new Date();
	}

	/** A bus event (onAny). */
	handle(name: string, data: Record<string, unknown>) {
		const printerId = typeof data.printerId === 'string' ? data.printerId : '';
		if (name === 'printer.online') {
			clearTimeout(this.offline.get(printerId));
			this.offline.delete(printerId);
			return;
		}
		if (!eventDef(name)) return;
		const message = buildMessage({ name, data }, this.o.lookups, this.o.settings.get().templates);
		if (!message) return;
		if (name === 'printer.offline') {
			clearTimeout(this.offline.get(printerId));
			const timer = setTimeout(() => {
				this.offline.delete(printerId);
				this.deliver(message);
			}, this.o.offlineDelayMs ?? 110_000);
			timer.unref?.();
			this.offline.set(printerId, timer);
			return;
		}
		this.deliver(message);
	}

	/** NotifyService: a message from another package. */
	notify(m: Parameters<NotifyService['notify']>[0]) {
		this.deliver({
			event: m.event || 'other',
			level: m.level,
			title: String(m.title).slice(0, 200),
			body: String(m.body ?? '').slice(0, 1000),
			printerId: m.printerId ?? null,
			jobId: null,
			// In-app paths only (not //host, which browsers read as another site).
			link: m.link && /^\/(?![/\\])/.test(m.link) ? m.link.slice(0, 500) : null,
			at: this.now().toISOString(),
			data: {},
			kidJob: false,
			hmsSeverity: null,
			dedupe: null
		});
	}

	/** Records the message and sends it where it is wanted. Returns the centre's row, if any. */
	deliver(message: Message): NotificationItem | null {
		const now = this.now();
		if (message.dedupe) {
			const before = this.told.get(message.dedupe);
			if (before && now.getTime() - before < DEDUPE_MS) return null;
			this.told.set(message.dedupe, now.getTime());
			for (const [k, t] of this.told) if (now.getTime() - t > DEDUPE_MS) this.told.delete(k);
		}
		const settings = this.o.settings.get();
		let item: NotificationItem | null = null;
		if (settings.inApp.includes(toggleName(message.event))) {
			item = this.store.add({ ...message, at: message.at });
			this.o.live.send(LIVE_CHANNEL, { unread: this.store.unread(), item });
		}
		const targets = settings.channels.filter((c) => wants(c, message, now));
		if (targets.length) this.track(this.send(targets, message, settings.kidPictures));
		return item;
	}

	private track(p: Promise<unknown>) {
		this.pending.add(p);
		void p.finally(() => this.pending.delete(p));
	}

	/** Resolves when every delivery started so far has finished (tests, shutdown). */
	async idle() {
		while (this.pending.size) await Promise.allSettled([...this.pending]);
	}

	private async send(channels: StoredChannel[], message: Message, kidPictures: boolean) {
		let picture: Promise<Buffer | null> | null = null;
		const pictureFor = (c: StoredChannel) =>
			wantsPicture(c, message, kidPictures)
				? (picture ??= this.snapshot(message.printerId!))
				: Promise.resolve(null);
		await Promise.allSettled(
			channels.map(async (c) => {
				const result = await this.sendOne(c, {
					event: message.event,
					level: message.level,
					title: message.title,
					body: message.body,
					link: message.link,
					url: this.o.origin && message.link ? `${this.o.origin}${message.link}` : null,
					at: message.at,
					data: message.data,
					picture: await pictureFor(c)
				});
				if (!result.ok)
					this.o.log(`${c.kind} channel “${c.name || c.id}” failed: ${result.detail}`);
			})
		);
	}

	private async snapshot(printerId: string): Promise<Buffer | null> {
		const camera = this.o.camera();
		if (!camera?.has(printerId)) return null;
		try {
			return await camera.getSnapshot(printerId, {
				signal: AbortSignal.any([this.stopper.signal, AbortSignal.timeout(8000)])
			});
		} catch (error) {
			this.o.log(`No picture for the notification: ${(error as Error).message}`);
			return null;
		}
	}

	/** Sends to one channel and remembers how it went. */
	async sendOne(c: StoredChannel, d: Delivery): Promise<DeliveryResult> {
		let result: DeliveryResult;
		try {
			const detail = await this.transport(c, d);
			result = { at: this.now().toISOString(), ok: true, detail };
		} catch (error) {
			result = { at: this.now().toISOString(), ok: false, detail: (error as Error).message };
		}
		this.last.set(c.id, result);
		return result;
	}

	private async transport(c: StoredChannel, d: Delivery): Promise<string> {
		if (c.kind === 'desktop') {
			const bridge = this.o.desktop();
			if (!bridge) throw new Error('Works in the Family Print Lab desktop app only.');
			bridge.notify(d.title, d.body, d.link);
			return 'Shown.';
		}
		const signal = AbortSignal.any([
			this.stopper.signal,
			AbortSignal.timeout(this.o.timeoutMs ?? 15_000)
		]);
		if (c.kind === 'email')
			return sendMail({
				host: c.host,
				port: c.port,
				security: c.security,
				user: c.user,
				password: c.password,
				from: c.from,
				to: c.to,
				subject: d.title,
				text: [d.body, d.url].filter(Boolean).join('\n\n'),
				picture: d.picture,
				signal,
				tls: this.o.mailTls
			});
		return sendHttp(c, d, {
			fetch: this.o.fetch ?? fetch,
			signal,
			telegramApi: this.o.telegramApi ?? 'https://api.telegram.org'
		});
	}

	/** The Test button: a short message to one channel, whatever its event toggles and quiet hours. */
	test(c: StoredChannel): Promise<DeliveryResult> {
		return this.sendOne(c, {
			event: 'notification.test',
			level: 'info',
			title: 'Test from Family Print Lab',
			body: 'If you can read this, notifications reach you here.',
			link: '/',
			url: this.o.origin ? `${this.o.origin}/` : null,
			at: this.now().toISOString(),
			data: {},
			picture: null
		});
	}

	stop() {
		for (const timer of this.offline.values()) clearTimeout(timer);
		this.offline.clear();
		this.stopper.abort();
	}
}
