// Read-only link to a Bambu Lab printer in LAN-only + Developer Mode, via its local MQTT broker.
// Field names follow the community-documented report format (X1/P1/A1); newer models may add or rename
// fields, so every value is optional and unknown data is ignored rather than trusted.
import { EventEmitter } from 'node:events';
import { MqttClient } from './mqtt';
import {
	ACTIVE_PRINTER_STATES,
	type PrinterSnapshot,
	type PrinterStatus
} from '$lib/shared/domain';

type Raw = Record<string, unknown>;
const num = (v: unknown) => {
	const n = typeof v === 'string' ? Number(v) : v;
	return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const text = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
const color = (hex: unknown) =>
	typeof hex === 'string' && /^[0-9a-f]{6}/i.test(hex) ? `#${hex.slice(0, 6).toLowerCase()}` : null;

function merge(target: Raw, patch: Raw) {
	for (const [key, value] of Object.entries(patch ?? {})) {
		const current = target[key];
		if (
			value &&
			typeof value === 'object' &&
			!Array.isArray(value) &&
			current &&
			typeof current === 'object' &&
			!Array.isArray(current)
		)
			merge(current as Raw, value as Raw);
		else target[key] = value;
	}
	return target;
}

/** Turns the raw, incrementally-updated `print` report into the snapshot the app uses. */
export function summarize(p: Raw = {}): PrinterSnapshot {
	const ams = (p.ams ?? {}) as Raw;
	const units = Array.isArray(ams.ams) ? (ams.ams as Raw[]) : [];
	const trayNow = text(ams.tray_now, 8);
	return {
		gcodeState: text(p.gcode_state, 20) || 'UNKNOWN',
		percent: num(p.mc_percent),
		remainingMinutes: num(p.mc_remaining_time),
		layer: num(p.layer_num),
		totalLayers: num(p.total_layer_num),
		nozzle: num(p.nozzle_temper),
		nozzleTarget: num(p.nozzle_target_temper),
		bed: num(p.bed_temper),
		bedTarget: num(p.bed_target_temper),
		chamber: num(p.chamber_temper),
		task: text(p.subtask_name) || text(p.gcode_file),
		speedLevel: num(p.spd_lvl),
		printError: num(p.print_error) || 0,
		hms: Array.isArray(p.hms)
			? (p.hms as Raw[]).slice(0, 20).map((h) => ({ attr: num(h.attr), code: num(h.code) }))
			: [],
		wifiSignal: text(p.wifi_signal, 20),
		ams: units.slice(0, 8).map((unit) => ({
			unit: text(String(unit.id ?? ''), 8),
			humidity: num(unit.humidity),
			trays: (Array.isArray(unit.tray) ? (unit.tray as Raw[]) : []).slice(0, 4).map((tray) => ({
				slot: text(String(tray.id ?? ''), 8),
				active: trayNow !== '' && Number(trayNow) === Number(unit.id) * 4 + Number(tray.id),
				type: text(tray.tray_type, 40),
				name: text(tray.tray_sub_brands, 80),
				color: color(tray.tray_color),
				remain:
					num(tray.remain) !== null && (tray.remain as number) >= 0 ? (tray.remain as number) : null
			}))
		}))
	};
}

export interface PrinterConfig {
	host: string;
	serial: string;
	accessCode: string;
	name?: string;
	port?: number;
	useTls?: boolean;
	simulated?: boolean;
}

/** Emits 'update', 'started' {task}, 'finished' {task, ok}. */
export class BambuPrinter extends EventEmitter {
	private raw: Raw = {};
	private snapshot: PrinterSnapshot | null = null;
	private client: MqttClient | null = null;
	private timer?: NodeJS.Timeout;
	private retry = 0;
	private stopped = true;
	private lastState = '';
	private lastTask = '';
	connected = false;
	lastSeen: string | null = null;
	error = '';
	warning = '';

	constructor(readonly config: PrinterConfig) {
		super();
	}

	get name() {
		return this.config.name ?? 'Bambu Lab printer';
	}

	start() {
		this.stopped = false;
		this.open();
		return this;
	}

	private open() {
		const { host, port = 8883, useTls = true, serial, accessCode } = this.config;
		const client = new MqttClient({
			host,
			port,
			useTls,
			clientId: `print-lab-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
			username: 'bblp',
			password: accessCode,
			// The printer presents a self-signed certificate; we check that it names this printer's serial instead.
			tlsOptions: { rejectUnauthorized: false, checkServerIdentity: () => undefined }
		});
		this.client = client;
		client.on('connect', () => {
			if (useTls) {
				const cn = (client.socket as import('node:tls').TLSSocket).getPeerCertificate?.()?.subject
					?.CN;
				this.warning =
					cn && cn !== serial
						? `Printer certificate names “${cn}”, not the configured serial.`
						: '';
			}
			this.connected = true;
			this.error = '';
			this.retry = 0;
			client.subscribe(`device/${serial}/report`);
			client.publish(`device/${serial}/request`, {
				pushing: { sequence_id: '0', command: 'pushall' }
			});
			this.emit('update');
		});
		client.on('message', (_topic: string, payload: Buffer) => this.receive(payload));
		client.on('error', (error: NodeJS.ErrnoException) => (this.error = friendly(error)));
		client.on('close', () => {
			this.connected = false;
			this.emit('update');
			if (this.stopped) return;
			const delay = Math.min(60_000, 2000 * 2 ** this.retry++);
			this.timer = setTimeout(() => this.open(), delay);
		});
		client.connect();
	}

	private receive(payload: Buffer) {
		let message: { print?: Raw };
		try {
			message = JSON.parse(payload.toString('utf8'));
		} catch {
			return;
		}
		if (!message || typeof message.print !== 'object') return;
		merge(this.raw, message.print);
		this.snapshot = summarize(this.raw);
		this.lastSeen = new Date().toISOString();
		const { gcodeState: state, task } = this.snapshot;
		if (state !== this.lastState) {
			const from = this.lastState;
			this.lastState = state;
			if (ACTIVE_PRINTER_STATES.has(state) && !ACTIVE_PRINTER_STATES.has(from))
				this.emit('started', { task });
			if ((state === 'FINISH' || state === 'FAILED') && ACTIVE_PRINTER_STATES.has(from))
				this.emit('finished', { task: this.lastTask || task, ok: state === 'FINISH' });
		}
		if (task) this.lastTask = task;
		this.emit('update');
	}

	status(): PrinterStatus {
		return {
			configured: true,
			name: this.name,
			simulated: !!this.config.simulated,
			connected: this.connected,
			lastSeen: this.lastSeen,
			error: this.connected ? '' : this.error,
			warning: this.warning,
			printing: !!this.snapshot && ACTIVE_PRINTER_STATES.has(this.snapshot.gcodeState),
			state: this.snapshot
		};
	}

	stop() {
		this.stopped = true;
		clearTimeout(this.timer);
		this.client?.end();
	}
}

function friendly(error: NodeJS.ErrnoException) {
	if (error.code === 'ECONNREFUSED')
		return 'Printer refused the connection. Check that LAN-only mode and Developer Mode are on.';
	if (error.code === 'EHOSTUNREACH' || error.code === 'ETIMEDOUT' || error.code === 'ENETUNREACH')
		return 'Printer not reachable. Check its IP address and that it is on the same network.';
	return error.message || 'Printer connection failed.';
}

export function printerFromEnv(env: Record<string, string | undefined>): BambuPrinter | null {
	const { BAMBU_HOST: host, BAMBU_SERIAL: serial, BAMBU_ACCESS_CODE: accessCode } = env;
	if (!host || !serial || !accessCode) return null;
	return new BambuPrinter({
		host,
		serial,
		accessCode,
		name: env.BAMBU_NAME || 'Bambu Lab X2D',
		port: Number(env.BAMBU_PORT || 8883),
		useTls: env.BAMBU_TLS !== 'off',
		simulated: env.BAMBU_SIMULATED === '1'
	});
}
