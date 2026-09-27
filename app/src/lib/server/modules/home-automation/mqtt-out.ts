// Outbound MQTT (opt-in): the lab publishes to the family's own broker (Mosquitto, Home Assistant's
// add-on…) so home automation can see it. Retained JSON per printer on `<prefix>/<printer-id>/status`,
// lab events on `<prefix>/events/<name>`, `<prefix>/availability` online/offline, and optionally
// Home Assistant MQTT discovery configs so the printers show up as devices by themselves
// (https://www.home-assistant.io/integrations/mqtt/#mqtt-discovery). Uses the app's own MQTT client
// (printer/mqtt.ts, QoS 1 + retain). Nothing leaves the machine unless someone turns this on.
import net from 'node:net';
import { MqttClient } from '../../printer/mqtt';
import type { PrinterStatus } from '$lib/shared/printers/status';
import type { StoredSettings } from './validation';
import { haPrinter, scrub } from './export';

type MqttSettings = StoredSettings['mqtt'];

export function parseBrokerUrl(url: string): { host: string; port: number; tls: boolean } {
	const u = new URL(url);
	const tls = u.protocol === 'mqtts:';
	if (!tls && u.protocol !== 'mqtt:')
		throw new Error('Use an address like mqtt://192.168.1.10:1883.');
	return {
		host: u.hostname.replace(/^\[(.*)\]$/, '$1'),
		port: u.port ? Number(u.port) : tls ? 8883 : 1883,
		tls
	};
}

/** Where a broker address points (protocol, host and port), to tell whether it changed. */
export function brokerKey(url: string): string {
	try {
		const { host, port, tls } = parseBrokerUrl(url);
		return `${tls ? 'mqtts' : 'mqtt'}://${host.toLowerCase()}:${port}`;
	} catch {
		return url;
	}
}

/** The printer id as a discovery object id (letters, digits, _ and - only). */
const objectId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '_');

export const statusTopic = (prefix: string, printerId: string) => `${prefix}/${printerId}/status`;

/** Home Assistant discovery configs for one printer: topic → retained JSON payload. */
export function discoveryMessages(
	s: Pick<MqttSettings, 'topicPrefix' | 'discoveryPrefix'>,
	p: { id: string; name: string; model: string | null }
): { topic: string; payload: Record<string, unknown> }[] {
	const node = `printlab_${objectId(p.id)}`;
	const device = {
		identifiers: [node],
		name: p.name,
		manufacturer: 'Bambu Lab',
		...(p.model && { model: p.model })
	};
	const common = {
		state_topic: statusTopic(s.topicPrefix, p.id),
		availability_topic: `${s.topicPrefix}/availability`,
		device
	};
	const temp = {
		device_class: 'temperature',
		unit_of_measurement: '°C',
		state_class: 'measurement'
	};
	const sensors: [string, string, Record<string, unknown>][] = [
		['state', 'State', { value_template: '{{ value_json.state }}', icon: 'mdi:printer-3d' }],
		[
			'progress',
			'Progress',
			{
				value_template: '{{ value_json.progress }}',
				unit_of_measurement: '%',
				state_class: 'measurement'
			}
		],
		[
			'remaining',
			'Time left',
			{
				value_template: '{{ value_json.remaining_minutes }}',
				unit_of_measurement: 'min',
				device_class: 'duration'
			}
		],
		['layer', 'Layer', { value_template: '{{ value_json.layer }}' }],
		['task', 'Print', { value_template: '{{ value_json.task }}' }],
		['nozzle', 'Nozzle temperature', { value_template: '{{ value_json.nozzle_temp }}', ...temp }],
		['bed', 'Bed temperature', { value_template: '{{ value_json.bed_temp }}', ...temp }],
		[
			'chamber',
			'Chamber temperature',
			{ value_template: '{{ value_json.chamber_temp }}', ...temp }
		],
		['alerts', 'Alerts', { value_template: '{{ value_json.hms_count }}' }]
	];
	const binaries: [string, string, Record<string, unknown>][] = [
		[
			'online',
			'Online',
			{ device_class: 'connectivity', value_template: "{{ 'ON' if value_json.online else 'OFF' }}" }
		],
		[
			'printing',
			'Printing',
			{ device_class: 'running', value_template: "{{ 'ON' if value_json.printing else 'OFF' }}" }
		]
	];
	return [
		...sensors.map(([key, name, extra]) => ({
			topic: `${s.discoveryPrefix}/sensor/${node}/${key}/config`,
			payload: { name, unique_id: `${node}_${key}`, ...common, ...extra }
		})),
		...binaries.map(([key, name, extra]) => ({
			topic: `${s.discoveryPrefix}/binary_sensor/${node}/${key}/config`,
			payload: { name, unique_id: `${node}_${key}`, ...common, ...extra }
		}))
	];
}

/** The client's messages, reworded for a broker instead of a printer. */
function brokerError(message: string) {
	if (/access code/.test(message)) return 'The broker refused the user name or password.';
	return message
		.replace(/^Printer refused/, 'The broker refused')
		.replace(/^Printer stopped responding/, 'The broker stopped responding')
		.replace(/^Printer /, 'The broker ');
}

function client(s: MqttSettings) {
	const { host, port, tls } = parseBrokerUrl(s.url);
	return new MqttClient({
		host,
		port,
		useTls: tls,
		tlsOptions: {
			rejectUnauthorized: s.verifyTls,
			...(net.isIP(host) ? {} : { servername: host })
		},
		clientId: `printlab-${Math.random().toString(36).slice(2, 10)}`,
		username: s.username || undefined,
		password: s.password || undefined
	});
}

/** Connects once with these settings (Test button): ok, or why not, within 5 s. */
export function testBroker(s: MqttSettings): Promise<{ ok: boolean; detail: string }> {
	return new Promise((resolve) => {
		let c: MqttClient;
		try {
			c = client(s);
		} catch (error) {
			return resolve({ ok: false, detail: (error as Error).message });
		}
		let error = '';
		const started = Date.now();
		const done = (r: { ok: boolean; detail: string }) => {
			clearTimeout(timer);
			c.removeAllListeners();
			c.on('error', () => {});
			c.end();
			resolve(r);
		};
		const timer = setTimeout(
			() => done({ ok: false, detail: 'The broker did not answer within 5 seconds.' }),
			5000
		);
		c.on('connect', () => done({ ok: true, detail: `Connected in ${Date.now() - started} ms.` }));
		c.on('error', (e: Error) => (error = brokerError(e.message)));
		c.on('close', () => done({ ok: false, detail: error || 'The broker closed the connection.' }));
		c.connect();
	});
}

export interface MqttOutputDeps {
	settings(): MqttSettings;
	printers(): PrinterStatus[];
	power(printerId: string): boolean | null;
	log(message: string): void;
	/** Connection state changes ('off', 'connecting', 'connected' or an error). */
	onState?(state: string): void;
}

/** Keeps a connection to the broker while enabled and publishes the lab's state and events. */
export class MqttOutput {
	private client: MqttClient | null = null;
	private retry = 0;
	private reconnect?: NodeJS.Timeout;
	private stopped = true;
	private last = new Map<string, { key: string; at: number }>();
	private pending = new Map<string, NodeJS.Timeout>();
	/** Printers whose discovery configs are out, with the name and model they carry. */
	private announced = new Map<string, string>();
	/**
	 * Retained topics the lab has filled, by printer. Kept across reconnects and restarts so a removed
	 * printer, a new topic prefix or discovery turned off leaves nothing stale on the broker.
	 */
	private retained = new Map<string, Set<string>>();
	/** The settings of the current connection (a restart saves new ones before the old session ends). */
	private s: MqttSettings | null = null;
	private heartbeat?: NodeJS.Timeout;
	state = 'off';

	constructor(
		private deps: MqttOutputDeps,
		private o: { throttleMs?: number; refreshMs?: number } = {}
	) {}

	private setState(state: string) {
		if (state === this.state) return;
		this.state = state;
		this.deps.onState?.(state);
	}

	/** (Re)applies the settings: connects when enabled, disconnects otherwise. */
	restart() {
		this.stop();
		const s = this.deps.settings();
		if (!s.enabled || !s.url) return;
		this.stopped = false;
		this.open();
		this.heartbeat = setInterval(() => this.publishAll(true), this.o.refreshMs ?? 60_000);
		this.heartbeat.unref?.();
	}

	private open() {
		const s = this.deps.settings();
		let c: MqttClient;
		try {
			c = client(s);
		} catch (error) {
			this.setState((error as Error).message);
			return;
		}
		this.client = c;
		this.s = s;
		this.setState('connecting');
		let error = '';
		c.on('connect', () => {
			this.retry = 0;
			this.setState('connected');
			// A new session may be a new broker: say everything again, then clear what is no longer
			// said (another prefix, discovery off, printers removed meanwhile).
			this.last.clear();
			this.announced.clear();
			const before = this.retained;
			this.retained = new Map();
			void this.publish(`${s.topicPrefix}/availability`, 'online', true);
			this.publishAll(true);
			const now = new Set([...this.retained.values()].flatMap((t) => [...t]));
			for (const topics of before.values())
				for (const topic of topics) if (!now.has(topic)) void this.publish(topic, '', true);
		});
		c.on('error', (e: Error) => (error = brokerError(e.message)));
		c.on('close', () => {
			if (this.client !== c) return;
			this.client = null;
			if (this.stopped) return this.setState('off');
			this.setState(error || 'The broker closed the connection.');
			const delay = Math.min(60_000, 2000 * 2 ** this.retry++);
			this.reconnect = setTimeout(() => this.open(), delay);
			this.reconnect.unref?.();
		});
		c.connect();
	}

	stop() {
		this.stopped = true;
		clearTimeout(this.reconnect);
		clearInterval(this.heartbeat);
		for (const t of this.pending.values()) clearTimeout(t);
		this.pending.clear();
		const c = this.client;
		const prefix = this.s?.topicPrefix;
		this.client = null;
		if (c?.connected && prefix) {
			// Say goodbye so subscribers mark the lab unavailable, then disconnect.
			void c
				.publish(`${prefix}/availability`, 'offline', {
					qos: 1,
					retain: true,
					timeoutMs: 2000
				})
				.catch(() => {})
				.finally(() => c.end());
		} else c?.end();
		this.setState('off');
	}

	private publish(topic: string, payload: unknown, retain: boolean): Promise<void> {
		const c = this.client;
		if (!c?.connected) return Promise.resolve();
		return c
			.publish(topic, payload, { qos: 1, retain })
			.catch((e: Error) => this.deps.log(`MQTT publish to ${topic} failed: ${e.message}`));
	}

	/** A retained message for a printer, remembered so it can be cleared later. */
	private publishRetained(printerId: string, topic: string, payload: unknown) {
		const topics = this.retained.get(printerId) ?? new Set();
		topics.add(topic);
		this.retained.set(printerId, topics);
		void this.publish(topic, payload, true);
	}

	/** Every printer's status now (on connect and every minute); discovery configs and removals too. */
	private publishAll(force = false) {
		const s = this.s;
		if (!s) return;
		const printers = this.deps.printers().filter((p) => p.id);
		const ids = new Set(printers.map((p) => p.id!));
		for (const p of printers) {
			const who = { id: p.id!, name: p.name ?? '', model: p.modelName ?? null };
			const said = JSON.stringify(who);
			if (s.discovery && this.announced.get(p.id!) !== said) {
				for (const m of discoveryMessages(s, who)) this.publishRetained(p.id!, m.topic, m.payload);
				this.announced.set(p.id!, said);
			}
			this.publishStatus(p, force);
		}
		// Printers removed since: clear their retained messages.
		for (const id of [...this.retained.keys()]) if (!ids.has(id)) this.forget(id);
	}

	/** Clears a removed printer's retained status and discovery configs. */
	private forget(id: string) {
		for (const topic of this.retained.get(id) ?? []) void this.publish(topic, '', true);
		this.retained.delete(id);
		this.announced.delete(id);
		this.last.delete(id);
	}

	private publishStatus(p: PrinterStatus, force = false) {
		if (!this.s) return;
		const payload = haPrinter(p, this.deps.power(p.id!));
		const { updated_at: _, ...rest } = payload;
		const key = JSON.stringify(rest);
		const prev = this.last.get(p.id!);
		if (!force && prev?.key === key) return;
		this.last.set(p.id!, { key, at: Date.now() });
		this.publishRetained(p.id!, statusTopic(this.s.topicPrefix, p.id!), payload);
	}

	/** A printer's status changed: publish it, at most once per throttle window. */
	printerChanged(printerId: string) {
		if (!this.client?.connected || this.pending.has(printerId)) return;
		const wait = Math.max(
			0,
			(this.last.get(printerId)?.at ?? 0) + (this.o.throttleMs ?? 2000) - Date.now()
		);
		const timer = setTimeout(() => {
			this.pending.delete(printerId);
			const p = this.deps.printers().find((x) => x.id === printerId);
			if (p) this.publishStatus(p);
		}, wait);
		timer.unref?.();
		this.pending.set(printerId, timer);
	}

	/** The printer list changed (added, renamed, removed). */
	printersChanged() {
		if (this.client?.connected) this.publishAll(true);
	}

	/** A lab event, without addresses or serials (a printer.offline error can name the printer's IP). */
	event(name: string, data: unknown) {
		if (!this.s || !this.client?.connected) return;
		void this.publish(
			`${this.s.topicPrefix}/events/${name}`,
			{ event: name, ...(scrub(data) as object) },
			false
		);
	}
}
