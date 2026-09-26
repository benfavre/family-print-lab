// Minimal MQTT 3.1.1 client: enough to talk to a Bambu Lab printer on the local network. QoS 0 and 1
// (OpenBambuAPI mqtt.md: stop, pause and resume are sent with QoS 1), plus the retain flag for other
// brokers (home automation publishing).
import { EventEmitter } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';

export const TYPE = {
	CONNECT: 1,
	CONNACK: 2,
	PUBLISH: 3,
	PUBACK: 4,
	SUBSCRIBE: 8,
	SUBACK: 9,
	PINGREQ: 12,
	PINGRESP: 13,
	DISCONNECT: 14
} as const;

export interface Packet {
	type: number;
	code?: number;
	topic?: string;
	payload?: Buffer;
	id?: number;
	qos?: number;
	retain?: boolean;
	clientId?: string;
	username?: string;
	password?: string;
}

function encodeLength(n: number) {
	const bytes: number[] = [];
	do {
		let b = n % 128;
		n = Math.floor(n / 128);
		if (n > 0) b |= 128;
		bytes.push(b);
	} while (n > 0);
	return Buffer.from(bytes);
}
const str = (s: string) => {
	const b = Buffer.from(s, 'utf8');
	const len = Buffer.alloc(2);
	len.writeUInt16BE(b.length);
	return Buffer.concat([len, b]);
};
const packet = (header: number, body: Buffer) =>
	Buffer.concat([Buffer.from([header]), encodeLength(body.length), body]);

export const encode = {
	connect({
		clientId,
		username,
		password,
		keepalive = 30
	}: {
		clientId: string;
		username?: string;
		password?: string;
		keepalive?: number;
	}) {
		const flags = 0x02 | (username ? 0x80 : 0) | (password ? 0x40 : 0);
		const ka = Buffer.alloc(2);
		ka.writeUInt16BE(keepalive);
		return packet(
			TYPE.CONNECT << 4,
			Buffer.concat([
				str('MQTT'),
				Buffer.from([4, flags]),
				ka,
				str(clientId),
				username ? str(username) : Buffer.alloc(0),
				password ? str(password) : Buffer.alloc(0)
			])
		);
	},
	connack: (code = 0) => packet(TYPE.CONNACK << 4, Buffer.from([0, code])),
	subscribe(id: number, topic: string) {
		const pid = Buffer.alloc(2);
		pid.writeUInt16BE(id);
		return packet((TYPE.SUBSCRIBE << 4) | 2, Buffer.concat([pid, str(topic), Buffer.from([0])]));
	},
	suback(id: number) {
		const b = Buffer.alloc(3);
		b.writeUInt16BE(id);
		return packet(TYPE.SUBACK << 4, b);
	},
	publish(
		topic: string,
		payload: string | Buffer,
		o: { qos?: 0 | 1; retain?: boolean; id?: number } = {}
	) {
		const qos = o.qos ?? 0;
		const id = Buffer.alloc(qos ? 2 : 0);
		if (qos) id.writeUInt16BE(o.id ?? 1);
		return packet(
			(TYPE.PUBLISH << 4) | (qos << 1) | (o.retain ? 1 : 0),
			Buffer.concat([str(topic), id, Buffer.from(payload)])
		);
	},
	puback(id: number) {
		const b = Buffer.alloc(2);
		b.writeUInt16BE(id);
		return packet(TYPE.PUBACK << 4, b);
	},
	pingreq: () => Buffer.from([TYPE.PINGREQ << 4, 0]),
	pingresp: () => Buffer.from([TYPE.PINGRESP << 4, 0]),
	disconnect: () => Buffer.from([TYPE.DISCONNECT << 4, 0])
};

/** Largest packet accepted (printer reports are tens of kilobytes). */
export const MAX_PACKET = 4 * 1024 * 1024;

/** Splits a byte stream into packets; incomplete trailing bytes come back as `rest`. */
export function decode(buffer: Buffer, max = MAX_PACKET): { packets: Packet[]; rest: Buffer } {
	const packets: Packet[] = [];
	let offset = 0;
	while (buffer.length - offset >= 2) {
		let length = 0,
			multiplier = 1,
			i = offset + 1,
			byte: number;
		do {
			if (i >= buffer.length) return { packets, rest: buffer.subarray(offset) };
			byte = buffer[i++];
			length += (byte & 127) * multiplier;
			multiplier *= 128;
			if (multiplier > 128 ** 4) throw new Error('Malformed MQTT length.');
		} while (byte & 128);
		if (length > max) throw new Error('MQTT packet too large.');
		if (buffer.length < i + length) break;
		const header = buffer[offset],
			body = buffer.subarray(i, i + length),
			type = header >> 4;
		const p: Packet = { type };
		if (type === TYPE.CONNACK) p.code = body[1];
		if (type === TYPE.PUBLISH) {
			const qos = (header >> 1) & 3,
				topicLength = body.readUInt16BE(0);
			p.topic = body.subarray(2, 2 + topicLength).toString('utf8');
			p.qos = qos;
			p.retain = (header & 1) === 1;
			if (qos) p.id = body.readUInt16BE(2 + topicLength);
			p.payload = body.subarray(2 + topicLength + (qos ? 2 : 0));
		}
		if (type === TYPE.SUBSCRIBE || type === TYPE.SUBACK || type === TYPE.PUBACK)
			p.id = body.readUInt16BE(0);
		if (type === TYPE.SUBSCRIBE) {
			const tl = body.readUInt16BE(2);
			p.topic = body.subarray(4, 4 + tl).toString('utf8');
		}
		if (type === TYPE.CONNECT) {
			let o = 10;
			const read = () => {
				const l = body.readUInt16BE(o);
				const s = body.subarray(o + 2, o + 2 + l).toString('utf8');
				o += 2 + l;
				return s;
			};
			const flags = body[7];
			p.clientId = read();
			if (flags & 0x80) p.username = read();
			if (flags & 0x40) p.password = read();
		}
		packets.push(p);
		offset = i + length;
	}
	return { packets, rest: buffer.subarray(offset) };
}

export interface MqttOptions {
	host: string;
	port: number;
	useTls?: boolean;
	tlsOptions?: tls.ConnectionOptions;
	clientId: string;
	username?: string;
	password?: string;
	keepalive?: number;
	/**
	 * Decides on the TLS peer before anything is written (printer/tls.ts verifyPrinterCert): return
	 * an error message to refuse the connection, so the access code never reaches an unverified peer.
	 */
	verify?: (socket: tls.TLSSocket) => string | null;
}

/** Emits 'connect', 'message' (topic, payload), 'close' (wasConnected), 'error'. */
export class MqttClient extends EventEmitter {
	socket: net.Socket | tls.TLSSocket | null = null;
	connected = false;
	private buffer: Buffer = Buffer.alloc(0);
	private nextId = 1;
	private ping?: NodeJS.Timeout;
	/** QoS 1 publishes waiting for their PUBACK, by packet id. */
	private inflight = new Map<
		number,
		{ resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
	>();

	constructor(private options: MqttOptions) {
		super();
	}

	connect() {
		const { host, port, useTls = true, tlsOptions = {}, keepalive = 30, verify } = this.options;
		const onOpen = () => {
			const refused = useTls && verify ? verify(this.socket as tls.TLSSocket) : null;
			if (refused) return void this.socket!.destroy(new Error(refused));
			this.socket!.write(encode.connect(this.options));
		};
		this.socket = useTls
			? tls.connect({ host, port, ...tlsOptions }, onOpen)
			: net.connect({ host, port }, onOpen);
		this.socket.setTimeout((keepalive * 2 + 10) * 1000, () =>
			this.socket?.destroy(new Error('Printer stopped responding.'))
		);
		this.socket.on('data', (chunk: Buffer) => this.receive(chunk));
		this.socket.on('error', (error) => this.emit('error', error));
		this.socket.on('close', () => {
			clearInterval(this.ping);
			for (const waiting of this.inflight.values())
				waiting.reject(new Error('The printer disconnected before confirming the command.'));
			this.inflight.clear();
			const was = this.connected;
			this.connected = false;
			this.emit('close', was);
		});
		return this;
	}

	private receive(chunk: Buffer) {
		let result;
		try {
			result = decode(Buffer.concat([this.buffer, chunk]));
		} catch (error) {
			this.socket?.destroy(error as Error);
			return;
		}
		this.buffer = result.rest;
		for (const p of result.packets) {
			if (p.type === TYPE.CONNACK) {
				if (p.code !== 0) {
					this.socket?.destroy(
						new Error(
							p.code === 4 || p.code === 5
								? 'Printer rejected the access code.'
								: `Printer refused the connection (code ${p.code}).`
						)
					);
					return;
				}
				this.connected = true;
				this.ping = setInterval(
					() => this.socket?.write(encode.pingreq()),
					(this.options.keepalive ?? 30) * 500
				);
				this.emit('connect');
			}
			if (p.type === TYPE.PUBLISH) {
				if (p.qos === 1 && p.id !== undefined) this.socket?.write(encode.puback(p.id));
				this.emit('message', p.topic, p.payload);
			}
			if (p.type === TYPE.PUBACK && p.id !== undefined) {
				this.inflight.get(p.id)?.resolve();
				this.inflight.delete(p.id);
			}
		}
	}

	private packetId() {
		// Packet ids are 16-bit and never 0.
		this.nextId = (this.nextId % 0xffff) + 1;
		return this.nextId;
	}

	subscribe(topic: string) {
		this.socket?.write(encode.subscribe(this.packetId(), topic));
	}

	/**
	 * Publishes a message. QoS 0 resolves once written; QoS 1 resolves when the broker acknowledges it
	 * (PUBACK) and rejects if the connection closes first.
	 */
	/**
	 * QoS 1 resolves on PUBACK and rejects on close or after `timeoutMs` (default 10 s) without one, so
	 * a caller never waits forever and the packet id is freed.
	 */
	publish(
		topic: string,
		payload: unknown,
		o: { qos?: 0 | 1; retain?: boolean; timeoutMs?: number } = {}
	): Promise<void> {
		const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
		const socket = this.socket;
		if (!socket || socket.destroyed || !this.connected)
			return Promise.reject(new Error('The printer is not connected.'));
		if (!o.qos) {
			socket.write(encode.publish(topic, body, { retain: o.retain }));
			return Promise.resolve();
		}
		const id = this.packetId();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.inflight.get(id)?.timer !== timer) return;
				this.inflight.delete(id);
				reject(new Error('The printer did not confirm the command.'));
			}, o.timeoutMs ?? 10_000);
			timer.unref?.();
			const settle = (fn: () => void) => {
				clearTimeout(timer);
				fn();
			};
			this.inflight.set(id, {
				resolve: () => settle(resolve),
				reject: (e) => settle(() => reject(e)),
				timer
			});
			socket.write(encode.publish(topic, body, { qos: 1, retain: o.retain, id }));
		});
	}
	end() {
		clearInterval(this.ping);
		if (this.socket && !this.socket.destroyed) {
			if (this.connected) this.socket.write(encode.disconnect());
			this.socket.end();
			this.socket.destroy();
		}
	}
}
