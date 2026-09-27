// The A1/P1 camera: JPEG frames over TLS on port 6000. Format per OpenBambuAPI video.md "A1 and P1"
// (https://github.com/Doridian/OpenBambuAPI at cc383a2) and ha-bambulab pybambu/bambu_client.py
// ChamberImageThread (https://github.com/greghesp/ha-bambulab at 0e027ff): the client sends an 80-byte
// auth packet (u32 LE 0x40, u32 LE 0x3000, u32 0, u32 0, 32-byte user "bblp", 32-byte access code,
// both NUL padded); the printer then sends, per frame, a 16-byte header (u32 LE payload size, itrack 0,
// flags 1, 0) and the JPEG (FF D8 … FF D9), about one frame a second. On other models port 6000 is the
// file tunnel with a different handshake (ClusterM open-bamboo-networking research/06.04-port-6000.md),
// so this is only ever used for models whose camera path says so, never to probe.
import net from 'node:net';
import tls from 'node:tls';
import type { CameraSource, FrameSink } from './source';

/** Frames bigger than this are a broken stream, not a picture (a 1280×720 JPEG is ~100–300 KB). */
export const MAX_FRAME = 4 * 1024 * 1024;

export function authPacket(username: string, accessCode: string): Buffer {
	const packet = Buffer.alloc(80);
	packet.writeUInt32LE(0x40, 0);
	packet.writeUInt32LE(0x3000, 4);
	packet.writeUInt32LE(0, 8);
	packet.writeUInt32LE(0, 12);
	packet.write(username.slice(0, 32), 16, 'ascii');
	packet.write(accessCode.slice(0, 32), 48, 'ascii');
	return packet;
}

/** The 16-byte frame header, as the printer (and the simulator) sends it. */
export function frameHeader(size: number): Buffer {
	const header = Buffer.alloc(16);
	header.writeUInt32LE(size, 0);
	header.writeUInt32LE(0, 4);
	header.writeUInt32LE(1, 8);
	header.writeUInt32LE(0, 12);
	return header;
}

/** Reads the auth packet back (the simulator's side). */
export function readAuthPacket(b: Buffer): { username: string; accessCode: string } | null {
	if (b.length < 80 || b.readUInt32LE(0) !== 0x40 || b.readUInt32LE(4) !== 0x3000) return null;
	const text = (from: number) =>
		b
			.subarray(from, from + 32)
			.toString('ascii')
			.replace(/\0+$/, '');
	return { username: text(16), accessCode: text(48) };
}

/**
 * Splits the byte stream into JPEG frames, whatever the chunking. Throws on a header with an
 * impossible size or a payload that is not a JPEG: the caller drops the connection and reconnects.
 */
export class FrameParser {
	private buffer: Buffer = Buffer.alloc(0);
	private need: number | null = null;

	constructor(private onFrame: (jpeg: Buffer) => void) {}

	push(chunk: Buffer) {
		this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
		for (;;) {
			if (this.need === null) {
				if (this.buffer.length < 16) return;
				const size = this.buffer.readUInt32LE(0);
				if (size < 4 || size > MAX_FRAME) throw new Error(`Bad camera frame size ${size}.`);
				this.need = size;
				this.buffer = this.buffer.subarray(16);
			}
			if (this.buffer.length < this.need) return;
			const jpeg = Buffer.from(this.buffer.subarray(0, this.need));
			this.buffer = this.buffer.subarray(this.need);
			this.need = null;
			if (!isJpeg(jpeg)) throw new Error('The camera sent something that is not a picture.');
			this.onFrame(jpeg);
		}
	}
}

export function isJpeg(b: Buffer): boolean {
	return (
		b.length >= 4 &&
		b[0] === 0xff &&
		b[1] === 0xd8 &&
		b[b.length - 2] === 0xff &&
		b[b.length - 1] === 0xd9
	);
}

export interface Jpeg6000Options {
	host: string;
	port: number;
	accessCode: string;
	/** TLS with this policy (printer/tls.ts); plain TCP for the simulator when absent. */
	tls?: { options: tls.ConnectionOptions; verify: (socket: tls.TLSSocket) => string | null };
	connectTimeoutMs?: number;
	/** No frame for this long: reconnect. */
	stallMs?: number;
}

/** Keeps a port-6000 connection up (reconnecting with backoff) and hands every frame to the sink. */
export function jpeg6000Source(o: Jpeg6000Options): CameraSource {
	let socket: net.Socket | null = null;
	let timer: NodeJS.Timeout | undefined;
	let stall: NodeJS.Timeout | undefined;
	let stopped = true;
	let retry = 0;
	let sink: FrameSink;

	const schedule = () => {
		if (stopped) return;
		const delay = Math.min(30_000, 1000 * 2 ** retry++);
		timer = setTimeout(connect, delay);
		timer.unref?.();
	};
	const armStall = () => {
		clearTimeout(stall);
		stall = setTimeout(
			() => socket?.destroy(new Error('The camera stopped sending pictures.')),
			o.stallMs ?? 15_000
		);
		stall.unref?.();
	};

	function connect() {
		if (stopped) return;
		let failure: string | null = null;
		const parser = new FrameParser((jpeg) => {
			retry = 0;
			armStall();
			sink.frame(jpeg);
		});
		const ready = () => {
			const refused = o.tls ? o.tls.verify(s as tls.TLSSocket) : null;
			if (refused) {
				failure = refused;
				return s.destroy();
			}
			s.setTimeout(0);
			s.write(authPacket('bblp', o.accessCode));
			armStall();
		};
		const s: net.Socket = o.tls
			? tls.connect({ ...o.tls.options, host: o.host, port: o.port }, ready)
			: net.connect({ host: o.host, port: o.port }, ready);
		socket = s;
		s.setTimeout(o.connectTimeoutMs ?? 10_000, () =>
			s.destroy(new Error('The camera did not answer.'))
		);
		s.on('data', (chunk: Buffer) => {
			try {
				parser.push(chunk);
			} catch (error) {
				failure = (error as Error).message;
				s.destroy();
			}
		});
		s.on('error', (error: NodeJS.ErrnoException) => {
			failure ??=
				error.code === 'ECONNREFUSED'
					? 'The printer refused the camera connection.'
					: error.message || 'The camera connection failed.';
		});
		s.on('close', () => {
			clearTimeout(stall);
			if (socket === s) socket = null;
			if (stopped) return;
			sink.error(failure ?? 'The camera connection closed.');
			schedule();
		});
	}

	return {
		start(s) {
			if (!stopped) return;
			sink = s;
			stopped = false;
			retry = 0;
			connect();
		},
		stop() {
			stopped = true;
			clearTimeout(timer);
			clearTimeout(stall);
			socket?.destroy();
			socket = null;
		}
	};
}
