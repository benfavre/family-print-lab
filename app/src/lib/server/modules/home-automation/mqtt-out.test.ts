// Outbound MQTT: what goes to the family's broker (retained status per printer, events, availability,
// Home Assistant discovery), checked on a recording broker built from the app's own MQTT codec, and
// the QoS 1 handshake against the printer simulator's broker.
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { decode, encode, TYPE } from '../../printer/mqtt';
import { createSimulator } from '../../printer/sim/core';
import { emptySnapshot, type PrinterStatus } from '$lib/shared/printers/status';
import { discoveryMessages, MqttOutput, parseBrokerUrl, testBroker } from './mqtt-out';
import { DEFAULT_SETTINGS } from './validation';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c();
});

interface Message {
	topic: string;
	payload: string;
	retain: boolean;
	qos: number;
}

/** A broker that accepts user "u" / password "p", acknowledges QoS 1 and records every publish. */
async function recordingBroker() {
	const messages: Message[] = [];
	const sockets = new Set<net.Socket>();
	const server = net.createServer((socket) => {
		sockets.add(socket);
		let buffer: Buffer = Buffer.alloc(0);
		socket.on('error', () => {});
		socket.on('data', (chunk) => {
			const out = decode(Buffer.concat([buffer, chunk]));
			buffer = out.rest;
			for (const p of out.packets) {
				if (p.type === TYPE.CONNECT)
					socket.write(encode.connack(p.username === 'u' && p.password === 'p' ? 0 : 5));
				if (p.type === TYPE.PUBLISH) {
					messages.push({
						topic: p.topic!,
						payload: p.payload!.toString(),
						retain: !!p.retain,
						qos: p.qos ?? 0
					});
					if (p.qos === 1) socket.write(encode.puback(p.id!));
				}
				if (p.type === TYPE.PINGREQ) socket.write(encode.pingresp());
			}
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
	cleanups.push(
		() =>
			new Promise((r) => {
				for (const s of sockets) s.destroy();
				server.close(() => r(null));
			})
	);
	return { messages, port: (server.address() as net.AddressInfo).port };
}

const printer = (over: Partial<PrinterStatus> = {}): PrinterStatus => ({
	configured: true,
	id: 'p-1',
	name: 'Kitchen P1S',
	model: 'C12',
	modelName: 'Bambu Lab P1S',
	connected: true,
	printing: true,
	state: emptySnapshot({
		gcodeState: 'RUNNING',
		percent: 42,
		nozzle: 219.6,
		bed: 55,
		task: 'rocket'
	}),
	...over
});

async function until(fn: () => boolean, ms = 5000) {
	const end = Date.now() + ms;
	while (!fn()) {
		if (Date.now() > end) throw new Error('Timed out');
		await new Promise((r) => setTimeout(r, 10));
	}
}

describe('MQTT output', () => {
	it('publishes availability, retained status, discovery configs and events', async () => {
		const broker = await recordingBroker();
		let printers = [printer()];
		const settings = {
			...DEFAULT_SETTINGS.mqtt,
			enabled: true,
			url: `mqtt://127.0.0.1:${broker.port}`,
			username: 'u',
			password: 'p',
			discovery: true
		};
		const states: string[] = [];
		const out = new MqttOutput(
			{
				settings: () => settings,
				printers: () => printers,
				power: () => true,
				log: () => {},
				onState: (s) => states.push(s)
			},
			{ throttleMs: 20 }
		);
		cleanups.push(() => out.stop());
		out.restart();
		await until(() => broker.messages.some((m) => m.topic === 'printlab/p-1/status'));
		expect(states).toEqual(['connecting', 'connected']);
		expect(broker.messages[0]).toEqual({
			topic: 'printlab/availability',
			payload: 'online',
			retain: true,
			qos: 1
		});
		const status = broker.messages.find((m) => m.topic === 'printlab/p-1/status')!;
		expect(status.retain).toBe(true);
		expect(status.qos).toBe(1);
		expect(JSON.parse(status.payload)).toMatchObject({
			id: 'p-1',
			name: 'Kitchen P1S',
			state: 'running',
			progress: 42,
			nozzle_temp: 219.6,
			power: true,
			task: 'rocket'
		});
		const config = broker.messages.find(
			(m) => m.topic === 'homeassistant/sensor/printlab_p-1/nozzle/config'
		)!;
		expect(config.retain).toBe(true);
		expect(JSON.parse(config.payload)).toMatchObject({
			unique_id: 'printlab_p-1_nozzle',
			state_topic: 'printlab/p-1/status',
			value_template: '{{ value_json.nozzle_temp }}',
			device_class: 'temperature',
			unit_of_measurement: '°C',
			device: { identifiers: ['printlab_p-1'], name: 'Kitchen P1S', manufacturer: 'Bambu Lab' }
		});

		// A change is published once (throttled); no change, nothing.
		const before = broker.messages.length;
		printers = [printer({ state: emptySnapshot({ gcodeState: 'RUNNING', percent: 43 }) })];
		out.printerChanged('p-1');
		out.printerChanged('p-1');
		await until(() => broker.messages.length > before);
		await new Promise((r) => setTimeout(r, 60));
		expect(broker.messages.slice(before).map((m) => m.topic)).toEqual(['printlab/p-1/status']);
		out.printerChanged('p-1');
		await new Promise((r) => setTimeout(r, 60));
		expect(broker.messages.length).toBe(before + 1);

		out.event('print.finished', {
			printerId: 'p-1',
			printerName: 'Kitchen P1S',
			task: 'rocket',
			at: 'now'
		});
		await until(() => broker.messages.some((m) => m.topic === 'printlab/events/print.finished'));
		const ev = broker.messages.find((m) => m.topic === 'printlab/events/print.finished')!;
		expect(ev.retain).toBe(false);
		expect(JSON.parse(ev.payload)).toMatchObject({ event: 'print.finished', printerId: 'p-1' });

		// A removed printer's retained messages are cleared.
		printers = [];
		out.printersChanged();
		await until(() =>
			broker.messages.some((m) => m.topic === 'printlab/p-1/status' && m.payload === '')
		);
		expect(
			broker.messages.some(
				(m) => m.topic === 'homeassistant/sensor/printlab_p-1/state/config' && m.payload === ''
			)
		).toBe(true);

		out.stop();
		await until(() =>
			broker.messages.some((m) => m.topic === 'printlab/availability' && m.payload === 'offline')
		);
		expect(states.at(-1)).toBe('off');
	});

	it('says why a broker refuses, and reconnects later', async () => {
		const broker = await recordingBroker();
		const settings = {
			...DEFAULT_SETTINGS.mqtt,
			enabled: true,
			url: `mqtt://127.0.0.1:${broker.port}`,
			username: 'u',
			password: 'bad'
		};
		expect(await testBroker(settings)).toEqual({
			ok: false,
			detail: 'The broker refused the user name or password.'
		});
		expect(await testBroker({ ...settings, password: 'p' })).toMatchObject({ ok: true });
		const states: string[] = [];
		const out = new MqttOutput({
			settings: () => settings,
			printers: () => [],
			power: () => null,
			log: () => {},
			onState: (s) => states.push(s)
		});
		cleanups.push(() => out.stop());
		out.restart();
		await until(() => states.includes('The broker refused the user name or password.'));
		expect(broker.messages).toEqual([]);
	});

	it('gets QoS 1 acknowledgements from the simulator broker', async () => {
		const sim = createSimulator({ log: () => {} });
		const port = await sim.listen(0, '127.0.0.1');
		cleanups.push(() => sim.close());
		const logs: string[] = [];
		const out = new MqttOutput({
			settings: () => ({
				...DEFAULT_SETTINGS.mqtt,
				enabled: true,
				url: `mqtt://127.0.0.1:${port}`,
				username: 'bblp',
				password: sim.accessCode
			}),
			printers: () => [printer()],
			power: () => null,
			log: (m) => logs.push(m)
		});
		cleanups.push(() => out.stop());
		out.restart();
		await until(() => out.state === 'connected');
		out.event('print.started', { printerId: 'p-1' });
		await new Promise((r) => setTimeout(r, 100));
		expect(logs).toEqual([]);
	});

	it('reads broker addresses', () => {
		expect(parseBrokerUrl('mqtt://192.168.1.10')).toEqual({
			host: '192.168.1.10',
			port: 1883,
			tls: false
		});
		expect(parseBrokerUrl('mqtts://broker.local')).toEqual({
			host: 'broker.local',
			port: 8883,
			tls: true
		});
		expect(parseBrokerUrl('mqtt://[::1]:1884')).toEqual({ host: '::1', port: 1884, tls: false });
		expect(() => parseBrokerUrl('http://x')).toThrow();
	});

	it('discovery ids use only letters, digits, _ and -', () => {
		const msgs = discoveryMessages(DEFAULT_SETTINGS.mqtt, { id: 'a.b c', name: 'X', model: null });
		for (const m of msgs)
			expect(m.topic).toMatch(
				/^homeassistant\/(sensor|binary_sensor)\/printlab_a_b_c\/\w+\/config$/
			);
		expect(msgs.find((m) => m.topic.includes('/online/'))!.payload).toMatchObject({
			device_class: 'connectivity'
		});
	});
});
