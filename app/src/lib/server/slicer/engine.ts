// The slicer engine client contract (slicer-engine implements it: StdioEngine for printlab-slicer
// over the Slicer Engine Protocol, CliEngine for stock Bambu Studio / OrcaSlicer). This foundation stub
// finds nothing, so the existing slicer.ts keeps slicing through the Bambu Studio command line.
import type {
	EngineCapability,
	EngineInfo,
	EngineMethods,
	Progress
} from '$lib/shared/slicer/protocol';

export interface SlicerEngine {
	readonly info: EngineInfo;
	has(cap: EngineCapability): boolean;
	call<M extends keyof EngineMethods>(
		method: M,
		params: EngineMethods[M]['params'],
		opts?: { signal?: AbortSignal; onProgress?: (p: Progress) => void; timeoutMs?: number }
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

/**
 * The engine binary if found and it negotiates, else the CLI backend, else null. Cached; restarted after
 * a crash. (Foundation stub: always null until the slicer-engine package lands.)
 */
export async function openSlicer(
	env: Record<string, string | undefined> = process.env
): Promise<SlicerEngine | null> {
	void env;
	return null;
}
