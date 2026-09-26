// The Slicer Engine Protocol: how the app talks to printlab-slicer (our headless engine built from
// Bambu Studio's libslic3r at the tag in slicer/upstream.lock, see slicer/UPSTREAM.md) or to the
// stock-CLI fallback backend. Types only (the slicer-engine package implements both sides).
//
// Transport: newline-delimited JSON-RPC 2.0 over the engine's stdin/stdout, one JSON object per line,
// UTF-8, no embedded newlines. stdout carries protocol only (the engine redirects everything upstream
// prints to stderr at startup); stderr is logs. Large data never goes inline: files live in a work
// directory the client passes in `engine.hello`; inline base64 is allowed only up to 1 MB.
//
// Versioning: the client requires an equal `major`; a lower `minor` is fine, and features are gated by
// the capability list, so an engine one release older or newer still works.
//
// Rules: requests are processed in order per `projectId` (different projects may run concurrently);
// `slice` can be cancelled with `$/cancel` (the engine calls upstream's print cancel and answers
// CANCELLED); the engine never writes outside `workDir` and paths the client passes; every error
// carries a plain-words `data.message`.
import type { SlicedPlate } from '../domain';
import type { PresetSelection, Project, Transform } from './project';
import type { PresetKind, PresetSummary, ResolvedBundle, UserPreset } from './profiles';
import type { PreviewHeader } from './preview';

export const PROTOCOL = { major: 1, minor: 0 } as const;
/** Largest inline base64 payload (bigger data goes through files in the work directory). */
export const MAX_INLINE_BYTES = 1024 * 1024;

export type EngineCapability =
	| 'project.open'
	| 'project.save'
	| 'project.sync'
	| 'mesh.put'
	| 'arrange'
	| 'orient'
	| 'slice'
	| 'slice.cancel'
	| 'export.gcode3mf'
	| 'export.thumbnails'
	| 'preview.v1'
	| 'profiles.resolve'
	| 'profiles.list'
	| 'paint.supports'
	| 'paint.seam'
	| 'paint.color'
	| 'paint.fuzzy_skin'
	| 'modifiers'
	| 'height_ranges'
	| 'variable_layer_height'
	| 'multi_nozzle'
	| 'config.validate'
	/** slicer-calibration generators (wave 2). */
	| `calib.${string}`;

export interface EngineInfo {
	engine: 'printlab-slicer' | 'bambu-studio-cli' | 'orca-slicer-cli';
	/** Our engine version (semver). */
	version: string;
	protocol: { major: number; minor: number };
	upstream: { name: 'BambuStudio' | 'OrcaSlicer'; tag: string; commit: string | null };
	/** null for CLI backends. */
	patchQueue: { version: number; hash: string; patches: string[] } | null;
	capabilities: EngineCapability[];
	/** BBL profiles shipped with this engine (same upstream tag). */
	profiles: { dir: string; vendorVersion: string } | null;
}

export interface Progress {
	stage:
		| 'loading'
		| 'preparing'
		| 'slicing'
		| 'perimeters'
		| 'infill'
		| 'support'
		| 'gcode'
		| 'exporting'
		| 'arranging'
		| 'orienting';
	percent: number;
	message: string;
}

export interface ConfigError {
	key: string;
	message: string;
	objectId?: string;
}
export interface SliceWarning {
	code: string;
	message: string;
	objectId?: string;
	plate?: number;
}
export interface PlateStats {
	plate: number;
	seconds: number;
	layers: number;
	filaments: { index: number; grams: number; meters: number }[];
	/** Per-object breakdown when available. */
	objects: { objectId: string; seconds: number | null; grams: number | null }[];
	warnings: SliceWarning[];
}
export interface PlateImages {
	plate: number;
	/** Path to a 512×512 PNG. */
	thumbnail: string;
	noLight?: string;
	top?: string;
	pick?: string;
	small?: string;
}

/** method → params/result. Notifications ($/…) are listed separately. */
export interface EngineMethods {
	'engine.hello': {
		params: {
			client: string;
			protocol: { major: number; minor: number };
			workDir: string;
			resourcesDir?: string;
		};
		result: EngineInfo;
	};
	'engine.ping': { params: Record<string, never>; result: { ok: true } };
	'engine.shutdown': { params: Record<string, never>; result: { ok: true } };
	'mesh.put': {
		params: { meshId: string; path: string; format: 'stl' | 'obj' | '3mf' | 'step' };
		result: {
			meshId: string;
			triangles: number;
			bbox: [number, number, number, number, number, number];
			repaired: { edgesFixed: number; facetsRemoved: number; facetsReversed: number };
		};
	};
	'mesh.drop': { params: { meshIds: string[] }; result: { ok: true } };
	/** Reads a .3mf with upstream's reader; meshes are written as binary STL into meshDir, referenced by MeshRef. */
	'project.open': {
		params: { path: string };
		result: { projectId: string; project: Project; meshDir: string };
	};
	'project.create': { params: { presets: PresetSelection }; result: { projectId: string } };
	/** The full desired state; the engine diffs by stable ids. */
	'project.sync': {
		params: { projectId: string; project: Project; presets: ResolvedBundle };
		result: { revision: number; errors: ConfigError[] };
	};
	/** An unsliced Bambu project 3MF. */
	'project.save': {
		params: { projectId: string; path: string; thumbnails?: PlateImages[] };
		result: { path: string };
	};
	'project.close': { params: { projectId: string }; result: { ok: true } };
	'config.validate': {
		params: { projectId: string; plate?: number };
		result: { errors: ConfigError[]; warnings: SliceWarning[] };
	};
	arrange: {
		params: {
			projectId: string;
			plate: number | 'all';
			spacing?: number;
			allowRotation?: boolean;
			alignment?: 'center' | 'x' | 'y';
		};
		result: {
			instances: { objectId: string; instanceId: string; plate: number; transform: Transform }[];
		};
	};
	orient: {
		params: { projectId: string; objectIds: string[] };
		result: { objects: { objectId: string; transform: Transform }[] };
	};
	/** Emits $/progress; cancellable. */
	slice: { params: { projectId: string; plate: number }; result: PlateStats };
	/** With Bambu metadata (slice_info.config, plate_N.json, md5, pick/top images). */
	'export.gcode3mf': {
		params: {
			projectId: string;
			plates: number[] | 'all';
			path: string;
			thumbnails: 'engine' | PlateImages[];
		};
		result: { path: string; plates: SlicedPlate[] };
	};
	/** Writes the preview container (preview.ts) to `path`. */
	'preview.get': {
		params: { projectId: string; plate: number; path: string; travel?: boolean };
		result: { path: string; header: PreviewHeader };
	};
	'profiles.list': {
		params: { kind: PresetKind; vendorDir?: string };
		result: { presets: PresetSummary[] };
	};
	/** Upstream's PresetBundle as the oracle for slicer-profiles tests. */
	'profiles.resolve': {
		params: { selection: PresetSelection; userPresets?: UserPreset[]; vendorDir?: string };
		result: ResolvedBundle;
	};
}
export type EngineMethod = keyof EngineMethods;

/** Notifications. Engine → client: $/progress, $/log. Client → engine: $/cancel. */
export interface EngineNotifications {
	'$/progress': { id: number | string; progress: Progress };
	'$/log': { level: 'debug' | 'info' | 'warn' | 'error'; message: string };
	'$/cancel': { id: number | string };
}

export const ERROR = {
	PARSE: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL: -32603,
	PROJECT_NOT_FOUND: 1001,
	MESH_NOT_FOUND: 1002,
	FILE_READ: 1003,
	UNSUPPORTED_FORMAT: 1004,
	INVALID_CONFIG: 1010,
	PRESET_NOT_FOUND: 1011,
	SLICE_FAILED: 1020,
	NOTHING_TO_SLICE: 1021,
	OUTSIDE_PLATE: 1022,
	CANCELLED: 1030,
	EXPORT_FAILED: 1040,
	CAPABILITY_MISSING: 1050,
	UPSTREAM_EXCEPTION: 1099
} as const;
/** error.data: plain words for the UI, plus upstream's text, the config key or object when known. */
export interface EngineErrorData {
	message: string;
	detail?: string;
	key?: string;
	objectId?: string;
}

/** JSON-RPC 2.0 messages as they travel, one per line. */
export type RpcRequest<M extends EngineMethod = EngineMethod> = {
	jsonrpc: '2.0';
	id: number | string;
	method: M;
	params: EngineMethods[M]['params'];
};
export type RpcResponse<M extends EngineMethod = EngineMethod> =
	| { jsonrpc: '2.0'; id: number | string; result: EngineMethods[M]['result'] }
	| {
			jsonrpc: '2.0';
			id: number | string | null;
			error: { code: number; message: string; data?: EngineErrorData };
	  };
export type RpcNotification<N extends keyof EngineNotifications = keyof EngineNotifications> = {
	jsonrpc: '2.0';
	method: N;
	params: EngineNotifications[N];
};

/** Whether an engine speaking `theirs` can serve this client (same major; any minor). */
export function compatibleProtocol(theirs: { major: number; minor: number }): boolean {
	return theirs.major === PROTOCOL.major;
}
