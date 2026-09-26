// Bambu Lab printer simulator for development and tests: a local MQTT endpoint that behaves like a
// printer in LAN-only + Developer Mode (login "bblp" + access code, device/<serial>/report, pushall and
// get_version), for any catalogue model. Reports have the real shape of that model (the starting state
// comes from the conformance fixtures: device blocks on H2/X2, vir_slot, AMS HT…): X1 models publish
// everything each tick, the others only what changed. It plays out prints with heating, layers, AMS
// usage, finish, failure and alerts, has the printer's file service (FTP) and obeys print commands the
// way the firmware answers them. Plain TCP, or TLS with a given certificate (tests of the TLS policy).
// Runs under tsx too (tools/printer-sim.ts), so no import.meta.glob here; features are listed in
// features/index.ts.
import net from 'node:net';
import tls from 'node:tls';
import { encode, decode, TYPE } from '../mqtt';
import { createFtpServer } from '../ftp-server';
import { readSliced } from '../sliced';
import { hexFlag } from '../flags';
import { simState } from './states';
import { FEATURES } from './features';
import {
	PRINTER_MODELS,
	isModelCode,
	sameModel,
	type ModelCode,
	type PrinterModel
} from '$lib/shared/printers/models';
import { EXT_DEPUTY, EXT_MAIN } from '$lib/shared/printers/status';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export interface SimOptions {
	model?: ModelCode;
	serial?: string;
	name?: string;
	accessCode?: string;
	speed?: number;
	auto?: boolean;
	failRate?: number;
	log?: (m: string) => void;
	/** Extra features beyond features/index.ts (tests). */
	features?: SimFeature[];
	/** Serve MQTT and FTP over TLS with this certificate (use CN = serial). */
	tls?: { key: string | Buffer; cert: string | Buffer };
}

/** A print the simulator is playing out. */
export interface SimJob {
	name: string;
	seconds: number;
	elapsed: number;
	grams: number;
	tray: number | null;
	startRemain: number;
	chamber: number;
	failAt: number;
}

export interface SimPrinter {
	model: PrinterModel;
	serial: string;
	name: string;
	/** The raw `print` object reports are made from. */
	state: Json;
	/** Delta or full per model.reports (full on pushall). */
	report(full?: boolean): void;
	answer(
		topic: string,
		command: string,
		sequence: unknown,
		result: 'success' | 'failed',
		extra?: Json
	): void;
	/** E.g. info.get_version replies. */
	publishRaw(topic: string, body: Json): void;
	files: Map<string, { data: Buffer }>;
	log(m: string): void;
	// Beyond the contract: the print lifecycle, for features and the control page.
	speed: number;
	auto: boolean;
	failRate: number;
	job: SimJob | null;
	print: SimPrintControl;
	/** Every tray with its global number (see GlobalTray). */
	trays(): { global: number; tray: Json; unit: Json | null }[];
	setActiveTray(global: number | null): void;
	temps(): {
		nozzle: number;
		nozzleTarget: number;
		bed: number;
		bedTarget: number;
		chamber: number;
	};
	setTemps(t: Partial<ReturnType<SimPrinter['temps']>>): void;
}

export interface SimPrintControl {
	start(o?: {
		name?: string;
		minutes?: number;
		slot?: number | string | null;
		layers?: number | null;
		grams?: number | null;
	}): SimJob;
	/** A project_file command: checks the uploaded file like the firmware would, then starts it. */
	startFile(msg: Json): void;
	finish(): void;
	fail(code?: number, why?: string): void;
	pause(): void;
	resume(): void;
	stop(): void;
}

export interface SimFeature {
	key: string;
	init?(sim: SimPrinter): void;
	/** Return undefined when not handled; otherwise the reply to send ('silent': handled, no reply). */
	command?(
		sim: SimPrinter,
		topic: string,
		msg: Json
	): { result: 'success' | 'failed'; reason?: string; extra?: Json } | 'silent' | undefined;
	step?(sim: SimPrinter, seconds: number): void;
	/** Buttons on the control page. */
	controls?: { id: string; label: string; run(sim: SimPrinter, body: Json): void }[];
}

const PLATES: Record<string, { nozzle: number; bed: number; chamber: number }> = {
	PLA: { nozzle: 220, bed: 55, chamber: 0 },
	PETG: { nozzle: 250, bed: 70, chamber: 0 },
	ABS: { nozzle: 260, bed: 90, chamber: 50 },
	ASA: { nozzle: 260, bed: 90, chamber: 50 },
	TPU: { nozzle: 230, bed: 35, chamber: 0 }
};
const SAMPLE_TASKS = [
	'cable_dock_v03',
	'pencil_rocket_v01',
	'drawer_divider_A',
	'phone_stand_v02',
	'room_sign_daughter',
	'adapter_tray_v01'
];
/** Print error for a cancelled task (Bambu Studio resources/hms/hms_en_094.json device_error 0300400C). */
export const SIM_CANCELLED = 0x0300400c;
const ACTIVE = ['PREPARE', 'RUNNING', 'PAUSE'];

const round = (n: number) => Math.round(n * 10) / 10;
/** (ams_id << 8) | slot_id, 0xFFFF for none (Bambu Studio DevExtruderSystem.cpp). */
function snowOf(global: number | null): number {
	if (global === null) return 0xffff;
	if (global === EXT_MAIN || global === EXT_DEPUTY) return global << 8;
	if (global >= 128) return global << 8;
	if (global >= 24 && global <= 27) return (16 << 8) | (global - 24);
	return ((global >> 2) << 8) | (global & 3);
}

export function createSimulator(o: SimOptions = {}) {
	const model = PRINTER_MODELS[o.model && isModelCode(o.model) ? o.model : 'N6'];
	const serial = o.serial ?? `SIM-${model.short.replace(/\W/g, '').toUpperCase()}-0001`;
	const accessCode = o.accessCode ?? '12345678';
	const log = o.log ?? console.log;
	const features = [...FEATURES, ...(o.features ?? [])];
	const start = simState(model.code);
	const versions = JSON.parse(JSON.stringify(start.get_version).replaceAll('**SERIAL**', serial));
	const sockets = new Set<net.Socket>();
	let sent: Json = {};
	let clock: NodeJS.Timeout | undefined;
	const files = createFtpServer({ accessCode, log, tls: o.tls });
	const s: Json = start.print;

	const packet = (body: Json) => encode.publish(`device/${serial}/report`, JSON.stringify(body));
	const broadcast = (body: Json) => {
		const p = packet(body);
		for (const socket of sockets) socket.write(p);
	};

	// ---- Shape-aware helpers: new-firmware models keep temperatures and trays under `device` ----
	const extruders = (): Json[] | null =>
		Array.isArray(s.device?.extruder?.info) ? s.device.extruder.info : null;
	const activeNozzle = () => ((s.device?.extruder?.state ?? 0) >> 4) & 0xf;
	const packed = (now: number, target: number) =>
		(Math.round(target) << 16) | Math.max(0, Math.round(now));
	// Fractions are kept here so heating stays smooth while packed reports carry whole degrees.
	const exact: { nozzle?: number; bed?: number; chamber?: number } = {};

	const printer: SimPrinter = {
		model,
		serial,
		name: o.name ?? model.name,
		state: s,
		speed: o.speed ?? 20,
		auto: o.auto ?? false,
		failRate: o.failRate ?? 0.15,
		job: null,
		files: files.files,
		log,
		report(full = false) {
			const t = printer.temps();
			const snapshot = structuredClone({
				...s,
				nozzle_temper: round(t.nozzle),
				bed_temper: round(t.bed),
				...('chamber_temper' in s && { chamber_temper: round(t.chamber) }),
				mc_percent: Math.floor(s.mc_percent),
				mc_remaining_time: Math.ceil(s.mc_remaining_time)
			});
			const everything = full || model.reports === 'full';
			const patch = everything
				? snapshot
				: Object.fromEntries(
						Object.entries(snapshot).filter(
							([k, v]) => JSON.stringify(v) !== JSON.stringify(sent[k])
						)
					);
			if (!Object.keys(patch).length) return;
			Object.assign(sent, structuredClone(patch));
			broadcast({
				print: {
					...patch,
					command: 'push_status',
					msg: everything ? 0 : 1,
					sequence_id: String(Date.now() % 100000)
				}
			});
		},
		answer(topic, command, sequence, result, extra = {}) {
			broadcast({
				[topic]: { command, sequence_id: String(sequence ?? '0'), result, ...extra }
			});
		},
		publishRaw(topic, body) {
			broadcast({ [topic]: body });
		},
		trays() {
			const out: { global: number; tray: Json; unit: Json | null }[] = [];
			for (const unit of s.ams?.ams ?? []) {
				const id = Number(unit.id);
				const type = hexFlag(unit.info, 0, 4);
				for (const tray of unit.tray ?? []) {
					const slot = Number(tray.id);
					const global =
						type === 4 || id >= 128 ? id : type === 5 || id === 16 ? 24 + slot : id * 4 + slot;
					out.push({ global, tray, unit });
				}
			}
			const vir = Array.isArray(s.vir_slot) ? s.vir_slot : null;
			if (vir) for (const t of vir) out.push({ global: Number(t.id), tray: t, unit: null });
			else if (s.vt_tray) out.push({ global: EXT_MAIN, tray: s.vt_tray, unit: null });
			return out;
		},
		setActiveTray(global) {
			if (s.ams)
				s.ams.tray_now =
					global === null
						? '255'
						: global === EXT_MAIN || global === EXT_DEPUTY
							? '254'
							: String(global);
			const list = extruders();
			if (list) {
				const nozzle = list.find((e) => e.id === activeNozzle()) ?? list[0];
				for (const e of list) if (e === nozzle) e.snow = snowOf(global);
			}
		},
		temps() {
			const list = extruders();
			const e = list?.find((x) => x.id === activeNozzle()) ?? list?.[0];
			const bed = s.device?.bed?.info?.temp;
			const ctc = s.device?.ctc?.info?.temp;
			return {
				nozzle: e ? (exact.nozzle ?? e.temp & 0xffff) : Number(s.nozzle_temper ?? 25),
				nozzleTarget: e ? (e.temp >> 16) & 0xffff : Number(s.nozzle_target_temper ?? 0),
				bed: typeof bed === 'number' ? (exact.bed ?? bed & 0xffff) : Number(s.bed_temper ?? 25),
				bedTarget:
					typeof bed === 'number' ? (bed >> 16) & 0xffff : Number(s.bed_target_temper ?? 0),
				chamber:
					typeof ctc === 'number' ? (exact.chamber ?? ctc & 0xffff) : Number(s.chamber_temper ?? 27)
			};
		},
		setTemps(t) {
			const now = { ...printer.temps(), ...t };
			const list = extruders();
			const e = list?.find((x) => x.id === activeNozzle()) ?? list?.[0];
			if (e) {
				exact.nozzle = now.nozzle;
				e.temp = packed(now.nozzle, now.nozzleTarget);
			}
			s.nozzle_temper = now.nozzle;
			s.nozzle_target_temper = now.nozzleTarget;
			if (typeof s.device?.bed?.info?.temp === 'number') {
				exact.bed = now.bed;
				s.device.bed.info.temp = packed(now.bed, now.bedTarget);
				if ('bed_temp' in s.device) s.device.bed_temp = s.device.bed.info.temp;
			}
			s.bed_temper = now.bed;
			s.bed_target_temper = now.bedTarget;
			if (typeof s.device?.ctc?.info?.temp === 'number') {
				exact.chamber = now.chamber;
				s.device.ctc.info.temp = packed(now.chamber, (s.device.ctc.info.temp >> 16) & 0xffff);
			}
			if ('chamber_temper' in s) s.chamber_temper = now.chamber;
		},
		print: {
			start: (x) => startPrint(x),
			startFile: (msg) => startFromFile(msg),
			finish,
			fail,
			pause,
			resume,
			stop
		}
	};
	function trayFor(global: number | null) {
		return global === null ? undefined : printer.trays().find((t) => t.global === global);
	}

	// One simulated second per call.
	function step() {
		const t = printer.temps();
		const approach = (now: number, target: number, rate: number) =>
			now + (Math.max(target, 25) - now) * rate;
		printer.setTemps({
			nozzle: approach(t.nozzle, t.nozzleTarget, 0.18),
			bed: approach(t.bed, t.bedTarget, 0.05),
			chamber: approach(t.chamber, Math.max(27, printer.job?.chamber || 0, t.bed * 0.45), 0.01)
		});
		for (const f of features) f.step?.(printer, 1);
		const j = printer.job;
		if (!j) return;
		const now = printer.temps();
		if (
			s.gcode_state === 'PREPARE' &&
			now.nozzle > now.nozzleTarget - 3 &&
			now.bed > now.bedTarget - 3
		) {
			s.gcode_state = 'RUNNING';
			s.stg_cur = 0;
			s.mc_print_stage = '2';
			log(`▶ printing "${j.name}"`);
		}
		if (s.gcode_state !== 'RUNNING') return;
		j.elapsed += 1;
		const progress = Math.min(1, j.elapsed / j.seconds);
		s.mc_percent = progress * 100;
		s.mc_remaining_time = Math.max(0, (j.seconds - j.elapsed) / 60);
		s.layer_num = Math.max(1, Math.ceil(progress * s.total_layer_num));
		const tray = trayFor(j.tray)?.tray;
		if (tray && tray.remain > 0 && j.tray !== null && j.tray < 254)
			tray.remain = Math.max(0, Math.round(j.startRemain - (progress * j.grams) / 10));
		if (j.failAt && progress >= j.failAt)
			return fail(0x0300800a, 'Spaghetti / first-layer detachment (simulated)');
		if (progress >= 1) finish();
	}

	function startPrint({
		name = SAMPLE_TASKS[Math.floor(Math.random() * SAMPLE_TASKS.length)],
		minutes = 45,
		slot = null as number | string | null,
		layers = null as number | null,
		grams = null as number | null
	} = {}): SimJob {
		if (ACTIVE.includes(s.gcode_state))
			throw new Error('A print is already running. Finish, fail or stop it first.');
		const trays = printer.trays().filter((t) => t.tray.tray_type);
		const chosen =
			slot !== null && slot !== ''
				? trayFor(Number(slot))
				: (trays.find((t) => t.unit) ?? trays[0]);
		if (!chosen?.tray?.tray_type)
			throw new Error(slot !== null ? `Tray ${slot} is empty.` : 'No filament is loaded.');
		const temps = PLATES[String(chosen.tray.tray_type).replace(/[-\s].*$/, '')] || PLATES.PLA;
		const job: SimJob = {
			name,
			seconds: Math.max(60, Math.round(minutes * 60)),
			elapsed: 0,
			grams: grams ?? Math.round(minutes * 1.1),
			tray: chosen.global,
			startRemain: Number(chosen.tray.remain) > 0 ? Number(chosen.tray.remain) : 100,
			chamber: temps.chamber,
			failAt: Math.random() < printer.failRate ? 0.1 + Math.random() * 0.6 : 0
		};
		printer.job = job;
		Object.assign(s, {
			gcode_state: 'PREPARE',
			subtask_name: name,
			gcode_file: `/data/Metadata/${name}.gcode`,
			mc_percent: 0,
			mc_remaining_time: minutes,
			layer_num: 0,
			total_layer_num: layers ?? Math.max(20, Math.round(minutes * 3.2)),
			print_error: 0,
			print_type: 'local',
			stg_cur: 2,
			mc_print_stage: '1'
		});
		// Dual-nozzle printers: the nozzle the chosen AMS unit feeds (AMS `info` bits 8–11).
		if (extruders() && chosen.unit) {
			const nozzle = hexFlag(chosen.unit.info, 8, 4);
			if (nozzle === 0 || nozzle === 1)
				s.device.extruder.state = (s.device.extruder.state & ~0xf0) | (nozzle << 4);
		}
		printer.setActiveTray(chosen.global);
		printer.setTemps({ nozzleTarget: temps.nozzle, bedTarget: temps.bed });
		log(
			`● heating for "${name}" (${minutes} min, ${chosen.tray.tray_type} in tray ${chosen.global})${job.failAt ? ' — this one will fail' : ''}`
		);
		printer.report();
		return job;
	}
	function settle(state: string) {
		s.gcode_state = state;
		s.mc_remaining_time = 0;
		s.stg_cur = 255;
		s.print_type = 'idle';
		s.mc_print_stage = '1';
		printer.setTemps({ nozzleTarget: 0, bedTarget: 0 });
		printer.setActiveTray(null);
		printer.job = null;
		printer.report();
		if (printer.auto)
			setTimeout(
				() => {
					if (!printer.job)
						try {
							startPrint({ minutes: 20 + Math.round(Math.random() * 60) });
						} catch {
							/* a print is already running; auto-play waits for the next finish */
						}
				},
				8000 / Math.max(1, printer.speed / 10)
			).unref?.();
	}
	function finish() {
		if (!printer.job) throw new Error('Nothing is printing.');
		s.mc_percent = 100;
		s.layer_num = s.total_layer_num;
		log(`✓ finished "${s.subtask_name}"`);
		settle('FINISH');
	}
	function fail(code = 0x0300800a, why = 'failed (simulated)') {
		if (!printer.job) throw new Error('Nothing is printing.');
		s.print_error = code;
		log(`✕ "${s.subtask_name}": ${why}`);
		settle('FAILED');
	}
	function pause() {
		if (s.gcode_state !== 'RUNNING') throw new Error('Only a running print can pause.');
		s.gcode_state = 'PAUSE';
		s.stg_cur = 16; // paused by the user
		log('❚❚ paused');
		printer.report();
	}
	function resume() {
		if (s.gcode_state !== 'PAUSE') throw new Error('Nothing is paused.');
		s.gcode_state = 'RUNNING';
		s.stg_cur = 0;
		log('▶ resumed');
		printer.report();
	}
	// Like the firmware: a stopped print ends as FAILED with "The task was canceled." (0300400C).
	function stop() {
		if (!printer.job) throw new Error('Nothing is printing.');
		log('■ stopped');
		s.print_error = SIM_CANCELLED;
		settle('FAILED');
	}
	function toggleAlert() {
		s.hms = s.hms?.length ? [] : [{ attr: 0x07000200, code: 0x00020001 }];
		log(s.hms.length ? '⚠ AMS alert raised (simulated)' : 'alert cleared');
		printer.report();
	}

	/** Checks a project_file command the way the firmware would and starts the print. */
	function startFromFile(msg: Json) {
		const name = String(msg.url ?? '').replace(/^(ftp|file):\/\/\/?(sdcard\/|mnt\/sdcard\/)?/, '');
		const stored = files.files.get(name);
		if (!stored) throw new Error(`File ${name} not found on the printer`);
		const sliced = readSliced(stored.data);
		if (sliced.printerModelId && !sameModel(sliced.printerModelId, model.code))
			throw new Error(
				`This file was sliced for another printer (${sliced.printerModelId}), not the ${model.short}`
			);
		const plateNo = Number(String(msg.param ?? '').match(/plate_(\d+)/)?.[1] ?? 1);
		const plate = sliced.plates.find((p) => p.index === plateNo);
		if (!plate) throw new Error(`Plate ${plateNo} is not in the file`);
		const mapping = Array.isArray(msg.ams_mapping2) ? msg.ams_mapping2 : [];
		const first =
			mapping.find((m: Json) => m && m.ams_id !== 255 && m.slot_id !== 255) ?? mapping[0];
		let tray: number | null = null;
		if (msg.use_ams && first) {
			const ams = Number(first.ams_id);
			const slot = Number(first.slot_id);
			tray =
				ams >= 128 || ams === EXT_DEPUTY || ams === EXT_MAIN
					? ams
					: ams === 16
						? 24 + slot
						: ams * 4 + slot;
			if (ams === 255 && slot === 255) tray = null;
		} else if (!msg.use_ams) tray = printer.trays().find((t) => !t.unit)?.global ?? null;
		startPrint({
			name: String(msg.subtask_name || name.replace(/\.gcode\.3mf$/, '')),
			minutes: plate.minutes,
			layers: plate.layers || null,
			grams: plate.grams || null,
			slot: tray
		});
	}

	function request(msg: Json) {
		for (const [topic, body] of Object.entries(msg ?? {}) as [string, Json][]) {
			if (!body || typeof body !== 'object') continue;
			if (topic === 'pushing' && body.command === 'pushall') {
				sent = {};
				printer.report(true);
				continue;
			}
			if (topic === 'info' && body.command === 'get_version') {
				printer.publishRaw('info', {
					...versions,
					command: 'get_version',
					sequence_id: String(body.sequence_id ?? '0'),
					result: 'success'
				});
				continue;
			}
			let handled = false;
			for (const f of features) {
				let out;
				try {
					out = f.command?.(printer, topic, body);
				} catch (error) {
					log(`✕ ${body.command}: ${(error as Error).message}`);
					out = { result: 'failed' as const, reason: (error as Error).message };
				}
				if (out === undefined) continue;
				handled = true;
				if (out !== 'silent')
					printer.answer(topic, String(body.command), body.sequence_id, out.result, {
						...(out.reason && { reason: out.reason }),
						...out.extra
					});
				break;
			}
			if (!handled) log(`(ignored command: ${topic}.${body.command})`);
		}
	}

	const onSocket = (socket: net.Socket) => {
		let buffer: Buffer = Buffer.alloc(0),
			authed = false;
		socket.on('data', (chunk: Buffer) => {
			let out;
			try {
				out = decode(Buffer.concat([buffer, chunk]));
			} catch {
				socket.destroy();
				return;
			}
			buffer = out.rest;
			for (const p of out.packets) {
				if (p.type === TYPE.CONNECT) {
					if (p.username !== 'bblp' || p.password !== accessCode) {
						log('✕ rejected a connection with the wrong access code');
						socket.write(encode.connack(5));
						socket.end();
						return;
					}
					authed = true;
					sockets.add(socket);
					socket.write(encode.connack(0));
					log('⇄ app connected');
				}
				if (!authed) continue;
				if (p.type === TYPE.SUBSCRIBE) socket.write(encode.suback(p.id ?? 1));
				if (p.type === TYPE.PINGREQ) socket.write(encode.pingresp());
				if (p.type === TYPE.PUBLISH && p.qos === 1 && p.id !== undefined)
					socket.write(encode.puback(p.id));
				if (p.type === TYPE.PUBLISH && p.topic === `device/${serial}/request`) {
					let msg: Json;
					try {
						msg = JSON.parse(p.payload!.toString());
					} catch {
						continue;
					}
					request(msg);
				}
				if (p.type === TYPE.DISCONNECT) socket.end();
			}
		});
		socket.on('error', () => {});
		socket.on('close', () => {
			if (sockets.delete(socket)) log('⇄ app disconnected');
		});
	};
	const broker = o.tls
		? tls.createServer({ ...o.tls, maxVersion: 'TLSv1.2' }, onSocket)
		: net.createServer(onSocket);

	function tick() {
		for (let i = 0; i < printer.speed; i++) step();
		printer.report();
	}

	for (const f of features) f.init?.(printer);

	return {
		/** The simulated printer (state, reports, lifecycle). */
		sim: printer,
		model,
		serial,
		accessCode,
		features,
		/** The firmware version it reports (ota module). */
		firmware: String(versions.module.find((m: Json) => m.name === 'ota')?.sw_ver ?? '01.00.00.00'),
		clients: () => sockets.size,
		start: startPrint,
		finish,
		fail,
		pause,
		resume,
		stop,
		toggleAlert,
		step,
		report: (full = false) => printer.report(full),
		setSpeed(n: unknown) {
			printer.speed = Math.max(1, Math.min(600, Number(n) || 1));
			log(`speed ×${printer.speed}`);
		},
		/** Files the app uploaded, by name. */
		files: files.files,
		/** Port of the file service once listening. */
		ftpPort: 0,
		/** Port of the MQTT broker once listening. */
		port: 0,
		async listen(port = 1883, host = '127.0.0.1', ftpPort = 0): Promise<number> {
			this.ftpPort = await files.listen(ftpPort);
			return new Promise((resolve, reject) => {
				broker.once('error', reject);
				broker.listen(port, host, () => {
					clock = setInterval(tick, 1000);
					this.port = (broker.address() as net.AddressInfo).port;
					resolve(this.port);
				});
			});
		},
		async close(): Promise<void> {
			clearInterval(clock);
			for (const socket of sockets) socket.destroy();
			await files.close();
			return new Promise((r) => broker.close(() => r()));
		}
	};
}

export type Simulator = ReturnType<typeof createSimulator>;
