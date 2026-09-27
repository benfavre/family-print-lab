// Print Lab Cloud link (optional): lets a grown-up answer kids' print requests from a phone, and,
// only when switched on, follow and pause the printers from it. Everything this sends and accepts is
// described in docs/cloud-protocol.md. In short: it opens one outbound WebSocket, reports print
// requests (and, only if switched on, the printers' status, alerts and queue), and accepts approving
// or declining a waiting request (the same checks as the Family page) plus, with protocol v2 and
// only when a parent allowed it, pause/resume/stop signed by a phone and sealed camera pictures
// (remote.ts, phone.ts).
import { eq } from 'drizzle-orm';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { DB } from '../db';
import { meta } from '../db/schema';
import type { Lab } from '../lab';
import type { ModelStore } from '../models';
import { AppError } from '../validation';
import { plaGrams } from '$lib/shared/kid';
import type { CloudBackup, CloudStatus } from '$lib/shared/cloud';
import { keyFrom, MAX_BACKUP, newRecoveryKey, pack, seal } from './vault';
import { installedPacks, parsePacks, savePacks } from '../kid/packs';
import type { PrinterStatus } from '$lib/shared/domain';
import { encodePhoneKey, newPhoneKey, phoneKeys, type PhoneKeys } from './phone';
import { printerState, Remote, type CloudHost, type RemoteSettings } from './remote';

export type { CloudHost } from './remote';

const KEY = 'cloud';
/** The newest protocol this app speaks; a cloud that only knows v1 gets v1 (see connect()). */
const PROTOCOL = 2;
const RECENT_DAYS = 7;
const MAX_THUMBNAIL = 40_000;
/** Progress is sent at most this often while printing; a change of state is sent at once. */
const PROGRESS_EVERY = 30_000;

interface Stored {
	shareNames: boolean;
	/** Share the printers' status (v1: the first printer's progress). */
	shareProgress?: boolean;
	shareAlerts?: boolean;
	shareQueue?: boolean;
	/** Camera snapshots and live view on the phone (sealed with the phone key). */
	snapshots?: boolean;
	/** Pause, resume and stop from the phone (turned on with the parent PIN). */
	remoteControl?: boolean;
	/** The household phone key (32 bytes, base64url) and when it was made; never sent to the cloud. */
	phoneKey?: { key: string; createdAt: string } | null;
	backup?: {
		recoveryKey: string;
		enabled: boolean;
		last: { at: string; size: number } | null;
		error: string | null;
	};
	link: {
		deviceToken: string;
		deviceId: string;
		account: string;
		linkedAt: string;
		/** This cloud has welcomed protocol v2, so a later refusal of v2 is never a reason to downgrade. */
		v2?: boolean;
	} | null;
}

export interface RequestSummary {
	id: string;
	version: number;
	status: string;
	kid: string;
	title: string;
	message: string;
	reply: string;
	size: [number, number, number] | null;
	grams: number | null;
	colour: { name: string; hex: string } | null;
	createdAt: string;
	decidedAt: string | null;
	thumbnail?: string | null;
}

export interface ShopItem {
	id: string;
	kind: 'kid-pack' | 'part' | 'model';
	kindLabel: string;
	title: string;
	blurb: string;
	description: string;
	price: number | null;
	plan: boolean;
	facts: string[];
	version: number;
	owned: boolean;
}
export interface ShopCatalogue {
	items: ShopItem[];
	balance: number;
	plan: boolean;
	/** The cloud's website, for "Get credits". */
	site: string;
}
export type LibraryItem = Omit<ShopItem, 'owned'> & {
	source?: string;
	name?: string;
	file?: string;
	format?: '3mf' | 'stl';
};

/** What the phone shows about the printer (only with "Share print progress" on). */
export interface PrinterSummary {
	state: 'idle' | 'preparing' | 'printing' | 'paused' | 'finished' | 'failed' | 'offline';
	title: string;
	percent: number | null;
	remainingMinutes: number | null;
	layer: number | null;
	totalLayers: number | null;
}

/** Protocol v1's printer: the first enabled one in Settings → Printers. */
export function summarizePrinter(status: PrinterStatus): PrinterSummary | null {
	if (!status.configured) return null;
	const s = status.connected ? status.state : null;
	const state = printerState(status);
	const active = state === 'preparing' || state === 'printing' || state === 'paused';
	return {
		state,
		title: s && state !== 'idle' ? s.task.slice(0, 120) : '',
		percent: active ? (s?.percent ?? null) : null,
		remainingMinutes: active ? (s?.remainingMinutes ?? null) : null,
		layer: active ? (s?.layer ?? null) : null,
		totalLayers: active ? (s?.totalLayers ?? null) : null
	};
}

export class CloudLink extends EventEmitter {
	private stored: Stored;
	private state: CloudStatus['state'] = 'unlinked';
	private plan = false;
	private error: string | null = null;
	private pairing: { userCode: string; verifyUrl: string; expiresAt: string } | null = null;
	private pairingRun = 0;
	private ws: WebSocket | null = null;
	private retry: ReturnType<typeof setTimeout> | null = null;
	private backoff = 1000;
	private ping: ReturnType<typeof setInterval> | null = null;
	private lastSent = '';
	private sendSoon: ReturnType<typeof setTimeout> | null = null;
	private stopped = false;
	private onChange = () => this.scheduleReport();
	private lastPrinter = '';
	private lastPrinterState = '';
	private lastPrinterAt = 0;
	private printerSoon: ReturnType<typeof setTimeout> | null = null;
	private onPrinter = () => this.schedulePrinter();
	/** The protocol spoken on the current connection (v2 unless the cloud only knows v1). */
	private protocol: 1 | 2 = PROTOCOL;
	private welcomed = false;
	private remote: Remote | null = null;
	private keys: PhoneKeys | null = null;
	private lastQueue = '';

	constructor(
		private db: DB,
		private lab: Lab,
		private models: ModelStore,
		readonly url: string,
		private appVersion: string,
		private deviceName = 'Family Print Lab',
		private host: CloudHost | null = null
	) {
		super();
		this.url = url.replace(/\/+$/, '');
		const row = db.select().from(meta).where(eq(meta.key, KEY)).get();
		this.stored = row ? (JSON.parse(row.value) as Stored) : { shareNames: true, link: null };
		lab.events.on('change', this.onChange);
		host?.on('update', this.onPrinter);
		if (host)
			this.remote = new Remote(
				host,
				lab,
				() => this.remoteSettings(),
				() => this.phoneKeys(),
				() => this.plan,
				() => this.schedulePrinter(true)
			);
	}

	start() {
		if (this.stored.link) void this.connect();
	}

	stop() {
		this.stopped = true;
		this.pairingRun++;
		this.lab.events.off('change', this.onChange);
		this.host?.off('update', this.onPrinter);
		this.remote?.stop();
		this.clearTimers();
		this.ws?.close(1000, 'Shutting down.');
	}

	status(): CloudStatus {
		return {
			configured: true,
			url: this.url,
			state: this.state,
			account: this.stored.link?.account ?? null,
			plan: this.plan,
			shareNames: this.stored.shareNames,
			shareProgress: this.stored.shareProgress === true,
			shareAlerts: this.stored.shareAlerts === true,
			shareQueue: this.stored.shareQueue === true,
			snapshots: this.stored.snapshots === true,
			remoteControl: this.stored.remoteControl === true,
			phoneKey: this.stored.phoneKey
				? { id: this.phoneKeys()!.id, createdAt: this.stored.phoneKey.createdAt }
				: null,
			protocol: this.protocol,
			backup: {
				enabled: this.stored.backup?.enabled === true,
				last: this.stored.backup?.last ?? null,
				error: this.stored.backup?.error ?? null
			},
			packs: installedPacks().map((p) => ({
				id: p.id,
				title: p.title,
				icon: p.icon,
				templates: p.templates.length
			})),
			pairing: this.pairing,
			error: this.error,
			linkedAt: this.stored.link?.linkedAt ?? null
		};
	}

	// ---------- Linking ----------

	/** Asks the cloud for a code for a grown-up to enter, then waits for them to confirm it. */
	async link() {
		if (this.stored.link) throw new AppError(409, 'Already linked. Unlink first.');
		const run = ++this.pairingRun;
		this.error = null;
		const started = await this.post<{
			pairingId: string;
			userCode: string;
			verifyUrl: string;
			expiresIn: number;
			interval: number;
		}>('/device/pair', { name: this.deviceName, app: this.appVersion });
		this.pairing = {
			userCode: started.userCode,
			verifyUrl: started.verifyUrl,
			expiresAt: new Date(Date.now() + started.expiresIn * 1000).toISOString()
		};
		this.set('pairing');
		void this.waitForConfirmation(run, started.pairingId, Math.max(0.05, started.interval) * 1000);
		return this.status();
	}

	cancelLink() {
		this.pairingRun++;
		this.pairing = null;
		if (this.state === 'pairing') this.set('unlinked');
	}

	private async waitForConfirmation(run: number, pairingId: string, interval: number) {
		while (run === this.pairingRun && this.pairing) {
			await new Promise((r) => setTimeout(r, interval));
			if (run !== this.pairingRun) return;
			try {
				const r = await this.post<{
					status: string;
					deviceToken?: string;
					deviceId?: string;
					account?: string;
				}>('/device/pair/poll', { pairingId });
				if (run !== this.pairingRun) return;
				if (r.status === 'expired') {
					this.pairing = null;
					this.error = 'The code expired. Start again to get a new one.';
					return this.set('unlinked');
				}
				if (r.status === 'linked' && r.deviceToken && r.deviceId) {
					this.pairing = null;
					this.save({
						...this.stored,
						link: {
							deviceToken: r.deviceToken,
							deviceId: r.deviceId,
							account: r.account ?? '',
							linkedAt: new Date().toISOString()
						}
					});
					this.lab.touch('cloud', `Linked to Print Lab Cloud (${r.account ?? 'account'})`);
					return void this.connect();
				}
			} catch {
				// Network hiccup while waiting: keep polling until the code expires.
			}
		}
	}

	/** Unlinks: tells the cloud when it can, and forgets the token either way. */
	async unlink() {
		const link = this.stored.link;
		this.cancelLink();
		if (link)
			await fetch(`${this.url}/device/unlink`, {
				method: 'POST',
				headers: { authorization: `Bearer ${link.deviceToken}` },
				signal: AbortSignal.timeout(5000)
			}).catch(() => {});
		this.forget(null);
		this.lab.touch('cloud', 'Unlinked from Print Lab Cloud');
	}

	setShareNames(share: boolean) {
		this.save({ ...this.stored, shareNames: share });
		this.lastSent = '';
		this.scheduleReport(0);
		this.emit('status', this.status());
	}

	/** Turning progress off also clears what the cloud has (it is sent `null`). */
	setShareProgress(share: boolean) {
		this.setRemote({ shareProgress: share });
	}

	/**
	 * What the phone may see and do (protocol v2). The route asks for the parent PIN before remote
	 * control goes on. Turning something off clears it from the cloud at once.
	 */
	setRemote(patch: Partial<RemoteSettings>) {
		this.save({ ...this.stored, ...patch });
		this.lastPrinter = this.lastQueue = '';
		this.sendPrinter();
		this.emit('status', this.status());
	}

	remoteSettings(): RemoteSettings {
		return {
			shareProgress: this.stored.shareProgress === true,
			shareAlerts: this.stored.shareAlerts === true,
			shareQueue: this.stored.shareQueue === true,
			snapshots: this.stored.snapshots === true,
			remoteControl: this.stored.remoteControl === true
		};
	}

	// ---------- The household phone key (v2) ----------

	private phoneKeys() {
		const stored = this.stored.phoneKey;
		if (!stored) return null;
		if (!this.keys) this.keys = phoneKeys(Buffer.from(stored.key, 'base64url'));
		return this.keys;
	}

	/**
	 * The phone key and the link a phone opens to keep it (the key is in the fragment, which browsers
	 * never send to a server). Made the first time; the route asks for the parent PIN first.
	 */
	phoneKey() {
		if (!this.stored.phoneKey) this.rotatePhoneKey(false);
		const key = this.stored.phoneKey!.key;
		return { id: this.phoneKeys()!.id, url: `${this.url}/phone-key#k=${key}` };
	}

	/** "Forget all phones": a new key, so phones holding the old one can no longer read or control. */
	forgetPhones() {
		this.rotatePhoneKey(true);
		return this.status();
	}

	private rotatePhoneKey(log: boolean) {
		this.keys = null;
		this.save({
			...this.stored,
			phoneKey: { key: encodePhoneKey(newPhoneKey()), createdAt: new Date().toISOString() }
		});
		if (log) this.lab.touch('cloud', 'New phone key: phones must scan it again');
		this.lastPrinter = this.lastQueue = '';
		this.sendPrinter();
		this.emit('status', this.status());
	}

	// ---------- Template packs (Family plan) ----------

	/** Fetches the packs the account may use; without the plan, installed packs are removed. */
	async syncPacks() {
		try {
			let packs: ReturnType<typeof parsePacks> = [];
			if (this.plan) {
				const response = await this.device('/device/packs', {
					signal: AbortSignal.timeout(30_000)
				});
				if (!response.ok) return;
				packs = parsePacks(((await response.json()) as { packs?: unknown }).packs);
			}
			const before = JSON.stringify(installedPacks());
			if (JSON.stringify(packs) === before) return;
			savePacks(this.db, packs);
			this.lab.touch(
				'cloud',
				packs.length
					? `Template packs: ${packs.map((p) => p.title).join(', ')}`
					: 'Template packs removed (no Family plan)'
			);
			this.emit('status', this.status());
		} catch {
			// Offline or a hiccup: keep what is installed and try again on the next connection.
		}
	}

	// ---------- Shop ----------

	/** The catalogue, with what this account owns, its credits and whether it has the plan. */
	async shopCatalogue() {
		return this.deviceJson<ShopCatalogue>('/device/shop');
	}

	/** Buys with the account's credits (402: not enough). */
	async buy(itemId: string) {
		return this.deviceJson<{ balance: number }>(`/device/shop/${encodeURIComponent(itemId)}/buy`, {
			method: 'POST'
		});
	}

	/** What the account owns, with what to install. */
	async library() {
		return (await this.deviceJson<{ items: LibraryItem[] }>('/device/library')).items;
	}

	/** A file from the library (a ready-made model). */
	async libraryFile(path: string) {
		if (!path.startsWith('/device/library/')) throw new AppError(400, 'Not a library file.');
		const response = await this.device(path, { signal: AbortSignal.timeout(120_000) });
		if (!response.ok) throw new AppError(502, 'Could not download it from Print Lab Cloud.');
		return Buffer.from(await response.arrayBuffer());
	}

	private images = new Map<string, Buffer>();
	/** A shop picture (public), kept in memory so the page loads fast the second time. */
	async shopImage(itemId: string) {
		if (!/^[a-z0-9-]{1,60}$/.test(itemId)) throw new AppError(404, 'No such picture.');
		const cached = this.images.get(itemId);
		if (cached) return cached;
		const response = await fetch(`${this.url}/shop/${itemId}.webp`, {
			signal: AbortSignal.timeout(15_000)
		}).catch(() => null);
		if (!response?.ok) throw new AppError(404, 'No such picture.');
		const image = Buffer.from(await response.arrayBuffer());
		this.images.set(itemId, image);
		return image;
	}

	private async deviceJson<T>(path: string, init: RequestInit = {}): Promise<T> {
		const response = await this.device(path, { signal: AbortSignal.timeout(20_000), ...init });
		const data = (await response.json().catch(() => ({}))) as T & { error?: string };
		if (!response.ok)
			throw new AppError(
				response.status === 402 || response.status === 409 ? response.status : 502,
				data.error ?? `Print Lab Cloud answered ${response.status}.`
			);
		return data;
	}

	// ---------- Encrypted backups (Family plan) ----------

	/** Turns cloud backups on; returns the recovery key (made once, kept on this computer). */
	enableBackup() {
		if (!this.stored.link) throw new AppError(409, 'Link this computer to Print Lab Cloud first.');
		const recoveryKey = this.stored.backup?.recoveryKey ?? newRecoveryKey();
		this.save({
			...this.stored,
			backup: { last: null, error: null, ...this.stored.backup, recoveryKey, enabled: true }
		});
		this.emit('status', this.status());
		return recoveryKey;
	}

	disableBackup() {
		if (this.stored.backup)
			this.save({ ...this.stored, backup: { ...this.stored.backup, enabled: false } });
		this.emit('status', this.status());
	}

	/** For "Show recovery key" (the Family page is behind the parent PIN). */
	recoveryKey() {
		return this.stored.backup?.recoveryKey ?? null;
	}

	backupEnabled() {
		return !!this.stored.link && this.stored.backup?.enabled === true;
	}

	/** Seals a snapshot folder with the recovery key and sends it; the cloud keeps the last 7. */
	async uploadBackup(snapshotDir: string) {
		const backup = this.stored.backup;
		if (!this.stored.link || !backup?.enabled) throw new AppError(409, 'Cloud backup is off.');
		const setResult = (patch: Partial<NonNullable<Stored['backup']>>) => {
			this.save({ ...this.stored, backup: { ...this.stored.backup!, ...patch } });
			this.emit('status', this.status());
		};
		try {
			const sealed = seal(pack(snapshotDir), backup.recoveryKey);
			if (sealed.length > MAX_BACKUP)
				throw new AppError(413, 'This backup is too big for the cloud (over 95 MB).');
			const response = await this.device('/device/backups', {
				method: 'PUT',
				headers: {
					'content-type': 'application/octet-stream',
					'x-backup-key': keyFrom(backup.recoveryKey).id
				},
				body: new Uint8Array(sealed),
				signal: AbortSignal.timeout(300_000)
			});
			if (!response.ok)
				throw new AppError(
					response.status === 402 ? 402 : 502,
					((await response.json().catch(() => ({}))) as { error?: string }).error ??
						`Print Lab Cloud answered ${response.status}.`
				);
			setResult({ last: { at: new Date().toISOString(), size: sealed.length }, error: null });
			return { size: sealed.length };
		} catch (error) {
			setResult({ error: (error as Error).message });
			throw error;
		}
	}

	/** Backups stored for the account, newest first. */
	async listBackups(): Promise<CloudBackup[]> {
		const response = await this.device('/device/backups', { signal: AbortSignal.timeout(15_000) });
		if (!response.ok) throw new AppError(502, `Print Lab Cloud answered ${response.status}.`);
		const { backups } = (await response.json()) as {
			backups: { id: string; device: string; createdAt: string; size: number; keyId: string }[];
		};
		const ours = this.stored.backup ? keyFrom(this.stored.backup.recoveryKey).id : null;
		return backups.map(({ keyId, ...b }) => ({ ...b, ours: keyId === ours }));
	}

	async downloadBackup(id: string): Promise<Buffer> {
		const response = await this.device(`/device/backups/${encodeURIComponent(id)}`, {
			signal: AbortSignal.timeout(300_000)
		});
		if (!response.ok) throw new AppError(404, 'That backup is not in the cloud any more.');
		return Buffer.from(await response.arrayBuffer());
	}

	private async device(path: string, init: RequestInit) {
		const link = this.stored.link;
		if (!link) throw new AppError(409, 'Link this computer to Print Lab Cloud first.');
		try {
			return await fetch(`${this.url}${path}`, {
				...init,
				headers: { ...init.headers, authorization: `Bearer ${link.deviceToken}` }
			});
		} catch {
			throw new AppError(502, 'Cannot reach Print Lab Cloud. Check the internet connection.');
		}
	}

	// ---------- Connection ----------

	private async connect() {
		this.clearTimers();
		const link = this.stored.link;
		if (!link || this.stopped) return;
		this.set('connecting');
		let ticket: string;
		try {
			const response = await fetch(`${this.url}/device/session`, {
				method: 'POST',
				headers: { authorization: `Bearer ${link.deviceToken}` },
				signal: AbortSignal.timeout(10_000)
			});
			if (response.status === 401)
				return this.forget('This computer was unlinked in Print Lab Cloud.');
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			ticket = ((await response.json()) as { ticket: string }).ticket;
		} catch {
			return this.reconnectLater('Cannot reach Print Lab Cloud.');
		}
		const ws = new WebSocket(
			`${this.url.replace(/^http/, 'ws')}/device/connect?ticket=${encodeURIComponent(ticket)}`
		);
		this.ws = ws;
		this.welcomed = false;
		ws.onopen = () =>
			ws.send(JSON.stringify({ type: 'hello', app: this.appVersion, protocol: this.protocol }));
		ws.onmessage = (e) => void this.onMessage(ws, String(e.data));
		ws.onclose = (e) => {
			if (this.ws !== ws) return;
			this.ws = null;
			if (this.ping) clearInterval(this.ping);
			if (e.code === 4401) return this.forget('This computer was unlinked in Print Lab Cloud.');
			// A cloud that does not know v2 yet refuses the hello: speak v1 to it (one printer, no
			// remote control), and try v2 again on the next connection, in case it was updated. Never
			// with a phone key, or once this cloud has spoken v2: v1 status travels in the clear, so a
			// cloud could otherwise refuse v2 to read what the phone key keeps sealed.
			const v2Only = !!this.phoneKeys() || !!this.stored.link?.v2;
			if (e.code === 4400 && !this.welcomed && this.protocol === 2 && !v2Only) {
				this.protocol = 1;
				return void this.connect();
			}
			const refused = e.code === 4400 && !this.welcomed && this.protocol === 2;
			this.protocol = PROTOCOL;
			this.reconnectLater(
				refused
					? 'Update Print Lab Cloud: it does not speak the protocol that keeps printer status sealed.'
					: e.code === 4400
						? e.reason || 'Update Family Print Lab.'
						: null
			);
		};
		ws.onerror = () => {};
	}

	private async onMessage(ws: WebSocket, text: string) {
		if (text === 'pong') return;
		let m: Record<string, unknown>;
		try {
			m = JSON.parse(text);
		} catch {
			return;
		}
		if (m.type === 'welcome') {
			this.welcomed = true;
			this.backoff = 1000;
			this.error = null;
			this.plan = m.plan === true;
			if (
				this.stored.link &&
				((typeof m.account === 'string' && m.account !== this.stored.link.account) ||
					(this.protocol === 2 && !this.stored.link.v2))
			)
				this.save({
					...this.stored,
					link: {
						...this.stored.link,
						...(typeof m.account === 'string' && { account: m.account }),
						...(this.protocol === 2 && { v2: true })
					}
				});
			this.set('online');
			this.ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), 30_000);
			this.lastSent = '';
			this.lastPrinter = this.lastQueue = '';
			this.report();
			// Always, so the cloud catches a print that ended while offline, and forgets the printer
			// if sharing was turned off meanwhile (then it is just `null`: nothing about the printer).
			this.sendPrinter();
			void this.syncPacks();
		} else if (m.type === 'plan') {
			this.plan = m.plan === true;
			this.emit('status', this.status());
			// Whether the phone may control follows the plan.
			this.lastPrinter = '';
			this.sendPrinter();
			void this.syncPacks();
		} else if (m.type === 'decide') {
			ws.send(JSON.stringify({ type: 'result', commandId: m.commandId, ...this.decide(m) }));
		} else if (m.type === 'control' && this.protocol === 2) {
			const result = this.remote
				? await this.remote.control(m)
				: { ok: false, error: 'Printers cannot be controlled here.' };
			if (ws.readyState === WebSocket.OPEN)
				ws.send(JSON.stringify({ type: 'result', commandId: m.commandId, ...result }));
		} else if (m.type === 'snapshot.request' && this.protocol === 2) {
			const answer = this.remote
				? await this.remote.snapshot(m)
				: {
						type: 'snapshot',
						requestId: String(m.requestId ?? '').slice(0, 80),
						printerId: String(m.printerId ?? '').slice(0, 80),
						error: 'Camera pictures are off.'
					};
			if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(answer));
		} else if (m.type === 'library') {
			// Something was bought (here or on the website): kid packs install themselves.
			void this.syncPacks();
			this.emit('library');
		} else if (m.type === 'unlinked') {
			this.forget('This computer was unlinked in Print Lab Cloud.');
		}
	}

	/** The only thing the cloud can ask for, applied exactly like an answer on the Family page. */
	private decide(m: Record<string, unknown>): { ok: boolean; error?: string } {
		if (
			typeof m.requestId !== 'string' ||
			!Number.isInteger(m.version) ||
			(m.decision !== 'approve' && m.decision !== 'decline')
		)
			return { ok: false, error: 'Malformed command.' };
		const by = typeof m.by === 'string' && m.by ? m.by.slice(0, 120) : 'Print Lab Cloud';
		try {
			this.lab.decideRequest(
				m.requestId,
				{
					decision: m.decision,
					reply: typeof m.reply === 'string' ? m.reply.slice(0, 300) : '',
					version: m.version
				},
				`the phone, ${by}`
			);
			return { ok: true };
		} catch (error) {
			return {
				ok: false,
				error: error instanceof AppError ? error.message : 'Could not apply it.'
			};
		}
	}

	private reconnectLater(error: string | null) {
		if (this.stopped || !this.stored.link) return;
		this.error = error;
		this.set('offline');
		this.retry = setTimeout(() => void this.connect(), this.backoff);
		this.backoff = Math.min(this.backoff * 2, 60_000);
	}

	private forget(error: string | null) {
		this.clearTimers();
		const ws = this.ws;
		this.ws = null;
		ws?.close(1000, 'Unlinked.');
		this.save({ ...this.stored, link: null });
		this.plan = false;
		this.error = error;
		this.set('unlinked');
	}

	// ---------- Reporting printers (opt-in) ----------

	/**
	 * A new state (started, paused, finished…), a new event or a new alert goes at once; progress at
	 * most every 30 s. `now`: something the phone should hear about right away.
	 */
	private schedulePrinter(now = false) {
		if (this.state !== 'online') return;
		if (now || this.printerSignature() !== this.lastPrinterState) {
			if (this.printerSoon) clearTimeout(this.printerSoon);
			this.printerSoon = null;
			return this.sendPrinter();
		}
		if (this.printerSoon) return;
		const wait = Math.max(0, this.lastPrinterAt + PROGRESS_EVERY - Date.now());
		this.printerSoon = setTimeout(() => {
			this.printerSoon = null;
			this.sendPrinter();
		}, wait);
	}

	/** What makes a report go at once: each printer's state, event and alerts. */
	private printerSignature() {
		if (this.protocol === 1) return this.printerSummary()?.state ?? '';
		const printers = this.remote?.summaries(false) ?? null;
		return JSON.stringify(
			printers?.map((p) => [p.id, p.state, p.event?.at, p.hms?.map((h) => h.key)]) ?? null
		);
	}

	/** v1: the first enabled printer only; nothing in the clear once a phone key exists. */
	private printerSummary() {
		if (this.phoneKeys()) return null;
		const first = this.host?.statuses().find((p) => p.configured && p.enabled !== false);
		return this.stored.shareProgress && first ? summarizePrinter(first) : null;
	}

	private sendPrinter() {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.welcomed) return;
		if (this.protocol === 1) {
			const printer = this.printerSummary();
			const message = JSON.stringify({ type: 'printer', printer });
			if (message === this.lastPrinter) return;
			this.lastPrinter = message;
			this.lastPrinterState = printer?.state ?? '';
			this.lastPrinterAt = Date.now();
			return this.ws.send(message);
		}
		const deviceId = this.stored.link?.deviceId ?? '';
		// Compared before sealing (every seal differs), so an unchanged report is not sent again.
		const plain = JSON.stringify([
			this.remote?.summaries() ?? null,
			this.remote?.queue() ?? null,
			this.remoteSettings(),
			this.plan,
			this.phoneKeys()?.id
		]);
		if (plain !== this.lastPrinter) {
			this.lastPrinter = plain;
			this.lastPrinterState = this.printerSignature();
			this.lastPrinterAt = Date.now();
			this.ws.send(
				JSON.stringify(
					this.remote?.printersMessage(deviceId) ?? { type: 'printers', printers: null }
				)
			);
		}
		const queue = this.remote?.queueMessage(deviceId) ?? {
			type: 'queue',
			items: null,
			event: null
		};
		const queuePlain = JSON.stringify([
			this.remote?.queue() ?? null,
			queue.event,
			this.phoneKeys()?.id
		]);
		if (queuePlain === this.lastQueue) return;
		this.lastQueue = queuePlain;
		this.ws.send(JSON.stringify(queue));
	}

	// ---------- Reporting requests ----------

	private scheduleReport(delay = 800) {
		if (this.state !== 'online') return;
		if (this.sendSoon) clearTimeout(this.sendSoon);
		this.sendSoon = setTimeout(() => this.report(), delay);
	}

	private report() {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
		const message = JSON.stringify({ type: 'requests', requests: this.summaries() });
		if (message === this.lastSent) return;
		this.lastSent = message;
		this.ws.send(message);
	}

	/** Waiting requests and those answered in the last week, with only what the phone shows. */
	summaries(): RequestSummary[] {
		const ws = this.lab.snapshot();
		const since = Date.now() - RECENT_DAYS * 86_400_000;
		return ws.printRequests
			.filter((r) => r.status === 'Waiting' || Date.parse(r.decidedAt ?? r.createdAt) > since)
			.map((r) => {
				const project = ws.projects.find((p) => p.id === r.projectId);
				const kid = ws.profiles.find((p) => p.id === r.profileId);
				const model = ws.models.find((m) => m.versions.some((v) => v.id === r.modelVersionId));
				const version = model?.versions.find((v) => v.id === r.modelVersionId);
				const spool = ws.spools.find((s) => s.id === r.spoolId);
				return {
					id: r.id,
					version: r.version,
					status: r.status,
					kid: this.stored.shareNames ? (kid?.name ?? 'Your child') : 'Your child',
					title: project?.title ?? 'Something they made',
					message: r.message,
					reply: r.reply,
					size: version
						? ([version.sizeX, version.sizeY, version.sizeZ].map((n) => Math.round(n)) as [
								number,
								number,
								number
							])
						: null,
					grams: version ? plaGrams(version.volume) : null,
					colour: spool ? { name: spool.colorName || spool.material, hex: spool.colorHex } : null,
					createdAt: r.createdAt,
					decidedAt: r.decidedAt,
					thumbnail:
						r.status === 'Waiting' && model && version ? this.thumbnail(model.id, version.id) : null
				};
			});
	}

	private thumbnail(modelId: string, versionId: string) {
		try {
			const file = this.models.path(modelId, versionId, 'webp');
			if (!fs.existsSync(file) || fs.statSync(file).size > MAX_THUMBNAIL) return null;
			return `data:image/webp;base64,${fs.readFileSync(file).toString('base64')}`;
		} catch {
			return null;
		}
	}

	// ---------- Plumbing ----------

	private async post<T>(path: string, body: unknown): Promise<T> {
		let response: Response;
		try {
			response = await fetch(`${this.url}${path}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(10_000)
			});
		} catch {
			throw new AppError(502, 'Cannot reach Print Lab Cloud. Check the internet connection.');
		}
		const data = (await response.json().catch(() => ({}))) as T & { error?: string };
		if (!response.ok)
			throw new AppError(502, data.error ?? `Print Lab Cloud answered ${response.status}.`);
		return data;
	}

	private save(next: Stored) {
		this.stored = next;
		const value = JSON.stringify(next);
		this.db
			.insert(meta)
			.values({ key: KEY, value })
			.onConflictDoUpdate({ target: meta.key, set: { value } })
			.run();
	}

	private set(state: CloudStatus['state']) {
		this.state = state;
		this.emit('status', this.status());
	}

	private clearTimers() {
		if (this.retry) clearTimeout(this.retry);
		if (this.ping) clearInterval(this.ping);
		if (this.sendSoon) clearTimeout(this.sendSoon);
		if (this.printerSoon) clearTimeout(this.printerSoon);
		this.retry = this.ping = this.sendSoon = this.printerSoon = null;
	}
}
