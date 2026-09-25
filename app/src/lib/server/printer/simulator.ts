// Bambu Lab printer simulator for development: a local MQTT endpoint that behaves like a printer in
// LAN-only + Developer Mode (login "bblp" + access code, device/<serial>/report, "pushall" requests),
// playing out prints with heating, layers, AMS usage, finish/failure and alerts. Plain TCP only.
import net from 'node:net';
import { encode, decode, TYPE } from './mqtt';

const AMS_DEFAULT = [
	{ type: 'PLA', color: '2B2F36FF', name: 'PLA Matte Charcoal', remain: 58 },
	{ type: 'PETG', color: '1FB8A6FF', name: 'PETG Translucent Teal', remain: 9 },
	{ type: 'PLA', color: 'FF7A2FFF', name: 'PLA Basic Orange', remain: 92 },
	null
];
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

export interface SimulatorOptions {
	serial?: string;
	accessCode?: string;
	speed?: number;
	auto?: boolean;
	failRate?: number;
	log?: (message: string) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export function createSimulator({
	serial = 'SIM-X2D-0001',
	accessCode = '12345678',
	speed = 20,
	auto = false,
	failRate = 0.15,
	log = console.log
}: SimulatorOptions = {}) {
	const sockets = new Set<net.Socket>();
	const sim: Json = {
		speed,
		auto,
		failRate,
		state: {
			gcode_state: 'IDLE',
			mc_percent: 0,
			mc_remaining_time: 0,
			layer_num: 0,
			total_layer_num: 0,
			nozzle_temper: 26,
			nozzle_target_temper: 0,
			bed_temper: 25,
			bed_target_temper: 0,
			chamber_temper: 27,
			subtask_name: '',
			gcode_file: '',
			spd_lvl: 2,
			print_error: 0,
			hms: [],
			wifi_signal: '-48dBm',
			ams: {
				tray_now: '255',
				ams: [
					{
						id: '0',
						humidity: '3',
						temp: '26.1',
						tray: AMS_DEFAULT.map((t, i) =>
							t
								? {
										id: String(i),
										tray_type: t.type,
										tray_sub_brands: t.name,
										tray_color: t.color,
										remain: t.remain
									}
								: { id: String(i) }
						)
					}
				]
			}
		},
		job: null,
		sent: {},
		clock: null
	};
	const s = sim.state,
		tray = () => s.ams.ams[0].tray[Number(s.ams.tray_now)];

	function publish(print: Json, full = false) {
		const patch = full
			? print
			: Object.fromEntries(
					Object.entries(print).filter(
						([k, v]) => JSON.stringify(v) !== JSON.stringify(sim.sent[k])
					)
				);
		if (!Object.keys(patch).length) return;
		Object.assign(sim.sent, structuredClone(patch));
		const packet = encode.publish(
			`device/${serial}/report`,
			JSON.stringify({
				print: {
					...patch,
					command: 'push_status',
					msg: full ? 0 : 1,
					sequence_id: String(Date.now() % 100000)
				}
			})
		);
		for (const socket of sockets) socket.write(packet);
	}
	const report = (full = false) =>
		publish(
			structuredClone({
				...s,
				nozzle_temper: round(s.nozzle_temper),
				bed_temper: round(s.bed_temper),
				chamber_temper: round(s.chamber_temper),
				mc_percent: Math.floor(s.mc_percent),
				mc_remaining_time: Math.ceil(s.mc_remaining_time)
			}),
			full
		);
	const round = (n: number) => Math.round(n * 10) / 10;

	// One simulated second per call.
	function step() {
		const approach = (now: number, target: number, rate: number) =>
			now + (Math.max(target, 25) - now) * rate;
		s.nozzle_temper = approach(s.nozzle_temper, s.nozzle_target_temper, 0.18);
		s.bed_temper = approach(s.bed_temper, s.bed_target_temper, 0.05);
		s.chamber_temper = approach(
			s.chamber_temper,
			Math.max(27, sim.job?.chamber || 0, s.bed_temper * 0.45),
			0.01
		);
		if (!sim.job) return;
		const j = sim.job;
		if (
			s.gcode_state === 'PREPARE' &&
			s.nozzle_temper > s.nozzle_target_temper - 3 &&
			s.bed_temper > s.bed_target_temper - 3
		) {
			s.gcode_state = 'RUNNING';
			log(`▶ printing "${j.name}"`);
		}
		if (s.gcode_state !== 'RUNNING') return;
		j.elapsed += 1;
		const progress = Math.min(1, j.elapsed / j.seconds);
		s.mc_percent = progress * 100;
		s.mc_remaining_time = Math.max(0, (j.seconds - j.elapsed) / 60);
		s.layer_num = Math.max(1, Math.ceil(progress * s.total_layer_num));
		const t = tray();
		if (t?.remain > 0)
			t.remain = Math.max(0, Math.round(j.startRemain - (progress * j.grams) / 10));
		if (j.failAt && progress >= j.failAt)
			return fail(0x0300800a, 'Spaghetti / first-layer detachment (simulated)');
		if (progress >= 1) finish();
	}

	function start({
		name = SAMPLE_TASKS[Math.floor(Math.random() * SAMPLE_TASKS.length)],
		minutes = 45,
		slot = null as number | string | null,
		layers = null as number | null,
		grams = null as number | null
	} = {}) {
		if (['PREPARE', 'RUNNING', 'PAUSE'].includes(s.gcode_state))
			throw new Error('A print is already running. Finish, fail or stop it first.');
		const trays = s.ams.ams[0].tray,
			index = slot !== null ? Number(slot) : trays.findIndex((t: Json) => t.tray_type);
		const t = trays[index];
		if (!t?.tray_type) throw new Error(`AMS slot ${Number(slot) + 1} is empty.`);
		const temps = PLATES[t.tray_type] || PLATES.PLA;
		sim.job = {
			name,
			seconds: Math.max(60, Math.round(minutes * 60)),
			elapsed: 0,
			grams: grams ?? Math.round(minutes * 1.1),
			startRemain: t.remain ?? 100,
			chamber: temps.chamber,
			failAt: Math.random() < sim.failRate ? 0.1 + Math.random() * 0.6 : 0
		};
		Object.assign(s, {
			gcode_state: 'PREPARE',
			subtask_name: name,
			gcode_file: `/data/Metadata/${name}.gcode`,
			mc_percent: 0,
			mc_remaining_time: minutes,
			layer_num: 0,
			total_layer_num: layers ?? Math.max(20, Math.round(minutes * 3.2)),
			nozzle_target_temper: temps.nozzle,
			bed_target_temper: temps.bed,
			print_error: 0
		});
		s.ams.tray_now = String(index);
		log(
			`● heating for "${name}" (${minutes} min, ${t.tray_type} in slot ${index + 1})${sim.job.failAt ? ' — this one will fail' : ''}`
		);
		report();
		return sim.job;
	}
	function settle(state: string) {
		s.gcode_state = state;
		s.nozzle_target_temper = 0;
		s.bed_target_temper = 0;
		s.mc_remaining_time = 0;
		s.ams.tray_now = '255';
		sim.job = null;
		report();
		if (sim.auto)
			setTimeout(
				() => {
					if (!sim.job)
						try {
							start({ minutes: 20 + Math.round(Math.random() * 60) });
						} catch {
							/* a print is already running; auto-play waits for the next finish */
						}
				},
				8000 / Math.max(1, sim.speed / 10)
			);
	}
	function finish() {
		if (!sim.job) throw new Error('Nothing is printing.');
		s.mc_percent = 100;
		s.layer_num = s.total_layer_num;
		log(`✓ finished "${s.subtask_name}"`);
		settle('FINISH');
	}
	function fail(code = 0x0300800a, why = 'failed (simulated)') {
		if (!sim.job) throw new Error('Nothing is printing.');
		s.print_error = code;
		log(`✕ "${s.subtask_name}": ${why}`);
		settle('FAILED');
	}
	function pause() {
		if (s.gcode_state !== 'RUNNING') throw new Error('Only a running print can pause.');
		s.gcode_state = 'PAUSE';
		log('❚❚ paused');
		report();
	}
	function resume() {
		if (s.gcode_state !== 'PAUSE') throw new Error('Nothing is paused.');
		s.gcode_state = 'RUNNING';
		log('▶ resumed');
		report();
	}
	function stop() {
		if (!sim.job) throw new Error('Nothing is printing.');
		log('■ stopped');
		settle('IDLE');
	}
	function toggleAlert() {
		s.hms = s.hms.length ? [] : [{ attr: 0x07000200, code: 0x00020001 }];
		log(s.hms.length ? '⚠ AMS alert raised (simulated)' : 'alert cleared');
		report();
	}

	const broker = net.createServer((socket) => {
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
				if (p.type === TYPE.PUBLISH && p.topic === `device/${serial}/request`) {
					let msg: Json;
					try {
						msg = JSON.parse(p.payload!.toString());
					} catch {
						continue;
					}
					if (msg.pushing?.command === 'pushall') {
						sim.sent = {};
						report(true);
					} else log(`(ignored command: ${JSON.stringify(msg).slice(0, 80)})`);
				}
				if (p.type === TYPE.DISCONNECT) socket.end();
			}
		});
		socket.on('error', () => {});
		socket.on('close', () => {
			if (sockets.delete(socket)) log('⇄ app disconnected');
		});
	});

	function tick() {
		for (let i = 0; i < sim.speed; i++) step();
		report();
	}

	return {
		sim,
		serial,
		accessCode,
		clients: () => sockets.size,
		start,
		finish,
		fail,
		pause,
		resume,
		stop,
		toggleAlert,
		step,
		report,
		setSpeed(n: unknown) {
			sim.speed = Math.max(1, Math.min(600, Number(n) || 1));
			log(`speed ×${sim.speed}`);
		},
		listen(port = 1883, host = '127.0.0.1'): Promise<number> {
			return new Promise((resolve) =>
				broker.listen(port, host, () => {
					sim.clock = setInterval(tick, 1000);
					resolve((broker.address() as net.AddressInfo).port);
				})
			);
		},
		close(): Promise<void> {
			clearInterval(sim.clock);
			for (const socket of sockets) socket.destroy();
			return new Promise((r) => broker.close(() => r()));
		}
	};
}

export type Simulator = ReturnType<typeof createSimulator>;
