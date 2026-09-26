// The Scene/Project model: a Bambu Studio project (3MF) as the app holds it, mirroring Bambu Studio's
// own model so a 3MF round-trips losslessly (slicer-3mf owns this file after the foundation; changes
// are additive). Names follow src/libslic3r/Format/bbs_3mf.cpp at the tag in slicer/upstream.lock.
import type { GlobalTray } from '../printers/status';
import type { PresetKind } from './profiles';

/**
 * 3MF transform: 12 numbers, row-major 3×4 as written in the `transform` attribute:
 * m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32 (3MF core spec).
 */
export type Transform = [
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number
];
/** Upstream serialises every option as text; per-filament/per-extruder options are arrays. */
export type ConfigValue = string | string[];
export type ConfigMap = Record<string, ConfigValue>;
/** sha256 (hex) of the canonical binary STL. */
export type MeshId = string;

export interface PresetRef {
	kind: PresetKind;
	name: string;
	source: 'system' | 'user' | 'project';
	userPresetId?: string;
}
export interface PresetSelection {
	printer: PresetRef;
	process: PresetRef;
	filaments: PresetRef[];
}

export interface MeshRef {
	id: MeshId;
	triangles: number;
	vertices: number;
	bbox: [number, number, number, number, number, number];
	storage:
		{ kind: 'file'; path: string } | { kind: 'model-version'; modelId: string; versionId: string };
}
/**
 * Facet painting exactly as Bambu Studio stores it: per-triangle TriangleSelector strings (hex),
 * sparse by triangle index. Attribute names: paint_supports, paint_seam, paint_color,
 * paint_fuzzy_skin (bbs_3mf.cpp).
 */
export interface PaintData {
	supports?: Record<number, string>;
	seam?: Record<number, string>;
	color?: Record<number, string>;
	fuzzySkin?: Record<number, string>;
}

export type PartType = 'model' | 'negative' | 'modifier' | 'support_blocker' | 'support_enforcer';
export interface Part {
	id: string;
	sourceId?: number;
	name: string;
	type: PartType;
	mesh: MeshId;
	/** Volume matrix relative to its object. */
	transform: Transform;
	/** Per-part overrides (e.g. extruder, wall_loops). */
	config: ConfigMap;
	/** 1-based extruder/filament. */
	filament?: number;
	paint?: PaintData;
	/** Generated modifiers. */
	primitive?: { kind: 'box' | 'cylinder' | 'sphere'; size: [number, number, number] };
	/** text_info attributes, kept verbatim. */
	text?: Record<string, string>;
}
export interface Instance {
	id: string;
	transform: Transform;
	printable: boolean;
	/** slice_info object id used by skip_objects. */
	identifyId?: number;
}
export interface HeightRange {
	minZ: number;
	maxZ: number;
	config: ConfigMap;
}
export interface SceneObject {
	id: string;
	sourceId?: number;
	name: string;
	parts: Part[];
	instances: Instance[];
	/** Per-object overrides. */
	config: ConfigMap;
	/** layer_config_ranges.xml. */
	heightRanges: HeightRange[];
	/** layer_heights_profile.txt: z,h pairs. */
	layerHeightProfile?: number[];
	printable: boolean;
	/** Unknown metadata, round-tripped. */
	extras?: Record<string, string>;
}
export type BedType =
	| 'Cool Plate'
	| 'Engineering Plate'
	| 'High Temp Plate'
	| 'Textured PEI Plate'
	| 'Supertack Plate'
	| (string & {});
export interface Plate {
	/** 1-based. */
	index: number;
	name: string;
	locked: boolean;
	bedType?: BedType;
	printSequence?: 'by layer' | 'by object';
	spiralVase?: boolean;
	filamentMapMode?: string;
	/** Dual-nozzle filament → nozzle mapping. */
	filamentMaps?: number[];
	firstLayerSequence?: number[];
	otherLayersSequence?: number[];
	instances: { objectId: string; instanceId: string }[];
	/** Plate-level overrides. */
	config: ConfigMap;
	/** Path. */
	thumbnail?: string;
}
export interface FilamentSlot {
	/** 1-based. */
	index: number;
	preset: PresetRef;
	color: string;
	type: string;
	tray?: GlobalTray | null;
	spoolId?: string | null;
	nozzle?: 0 | 1 | null;
}
export interface Project {
	format: 1;
	meta: {
		title: string;
		designer?: string;
		license?: string;
		origin?: string;
		description?: string;
		sourceUrl?: string;
		application?: string;
		createdAt?: string;
		modifiedAt?: string;
		extras?: Record<string, string>;
	};
	presets: PresetSelection;
	/** project_settings.config values that differ from the resolved presets. */
	projectConfig: ConfigMap;
	filaments: FilamentSlot[];
	plates: Plate[];
	objects: SceneObject[];
	meshes: Record<MeshId, MeshRef>;
	/** Files and XML we do not model, kept byte-for-byte for round-trips (path → base64 or file path). */
	passthrough: Record<string, { path: string } | { base64: string }>;
}

export const IDENTITY: Transform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

/** A new project with one empty plate and the given presets. */
export function emptyProject(presets: PresetSelection): Project {
	return {
		format: 1,
		meta: { title: 'Untitled' },
		presets,
		projectConfig: {},
		filaments: presets.filaments.map((preset, i) => ({
			index: i + 1,
			preset,
			color: '#FFFFFF',
			type: 'PLA'
		})),
		plates: [{ index: 1, name: '', locked: false, instances: [], config: {} }],
		objects: [],
		meshes: {},
		passthrough: {}
	};
}

/**
 * 3MF row-major 3×4 (points transform as row vectors: p' = p·M, translation in the last row) → a
 * three.js Matrix4 in column-major order (elements[]).
 */
export function transformToMatrix4(t: Transform): number[] {
	const [m00, m01, m02, m10, m11, m12, m20, m21, m22, m30, m31, m32] = t;
	// Column-major of the 4×4 that maps column vectors: x' = m00·x + m10·y + m20·z + m30.
	return [m00, m01, m02, 0, m10, m11, m12, 0, m20, m21, m22, 0, m30, m31, m32, 1];
}

/** The inverse of transformToMatrix4. */
export function matrix4ToTransform(m: ArrayLike<number>): Transform {
	return [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10], m[12], m[13], m[14]];
}
