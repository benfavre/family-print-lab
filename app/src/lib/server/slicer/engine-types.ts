// The SlicerEngine interface both backends implement (engine.ts: our engine over stdio; cli.ts: the
// stock Bambu Studio command line), kept apart so neither imports the other.
import type {
	EngineCapability,
	EngineInfo,
	EngineMethods,
	Progress
} from '$lib/shared/slicer/protocol';

export interface CallOptions {
	signal?: AbortSignal;
	onProgress?: (p: Progress) => void;
	timeoutMs?: number;
}

export interface SlicerEngine {
	readonly info: EngineInfo;
	has(cap: EngineCapability): boolean;
	call<M extends keyof EngineMethods>(
		method: M,
		params: EngineMethods[M]['params'],
		opts?: CallOptions
	): Promise<EngineMethods[M]['result']>;
	close(): Promise<void>;
}

/** An error the engine answered with (codes in protocol.ts ERROR); `message` is plain words for the UI. */
export class EngineError extends Error {
	constructor(
		readonly code: number,
		message: string,
		readonly data?: unknown
	) {
		super(message);
	}
}
