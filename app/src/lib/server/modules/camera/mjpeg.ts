// MJPEG over HTTP both ways: the multipart/x-mixed-replace stream the browser shows in an <img> (it
// works under the app's CSP `img-src 'self'`), and the parser for ffmpeg's `-f mpjpeg` output, whose
// parts carry a Content-Length header (libavformat/mpjpeg.c).

export const BOUNDARY = 'printlabframe';
export const MJPEG_CONTENT_TYPE = `multipart/x-mixed-replace; boundary=${BOUNDARY}`;

/** One part of the browser stream. */
export function mjpegPart(jpeg: Buffer): Buffer {
	return Buffer.concat([
		Buffer.from(
			`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`
		),
		jpeg,
		Buffer.from('\r\n')
	]);
}

const HEADER_END = Buffer.from('\r\n\r\n');

/** Splits ffmpeg's mpjpeg stream into JPEGs. Throws when the stream makes no sense. */
export class MpjpegParser {
	private buffer: Buffer = Buffer.alloc(0);
	private need: number | null = null;

	constructor(
		private onFrame: (jpeg: Buffer) => void,
		private maxFrame = 8 * 1024 * 1024
	) {}

	push(chunk: Buffer) {
		this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
		for (;;) {
			if (this.need === null) {
				const end = this.buffer.indexOf(HEADER_END);
				if (end < 0) {
					if (this.buffer.length > 8192) throw new Error('The video converter sent no pictures.');
					return;
				}
				const headers = this.buffer.subarray(0, end).toString('latin1');
				const length = headers.match(/content-length:\s*(\d+)/i);
				if (!length) throw new Error('The video converter sent a picture without a size.');
				const size = Number(length[1]);
				if (size > this.maxFrame) throw new Error('The video converter sent a huge picture.');
				this.need = size;
				this.buffer = this.buffer.subarray(end + HEADER_END.length);
			}
			if (this.buffer.length < this.need) return;
			const jpeg = Buffer.from(this.buffer.subarray(0, this.need));
			this.buffer = this.buffer.subarray(this.need);
			this.need = null;
			this.onFrame(jpeg);
		}
	}
}
