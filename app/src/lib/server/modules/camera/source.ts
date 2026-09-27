// What a camera session reads frames from: the port-6000 JPEG stream (jpeg6000.ts) or ffmpeg turning
// RTSP(S) into JPEGs (ffmpeg.ts).

export interface FrameSink {
	frame(jpeg: Buffer): void;
	/** The source failed; it retries by itself until stopped. `setup`: it cannot work until fixed. */
	error(message: string, o?: { setup?: boolean }): void;
}

export interface CameraSource {
	start(sink: FrameSink): void;
	stop(): void;
}
