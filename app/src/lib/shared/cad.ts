// Types shared by the model API and the workbench.
import type { ModelSummary, ModelVersionSummary } from './domain';

export interface Diagnostic {
	level: 'error' | 'warning';
	message: string;
	line: number | null;
}

/** A customizer parameter read from the top of an OpenSCAD file. */
export interface Parameter {
	name: string;
	type: 'number' | 'string' | 'boolean' | 'choice';
	value: string | number | boolean;
	group: string;
	description: string;
	min?: number;
	max?: number;
	step?: number;
	options?: { value: string | number; label: string }[];
}

export type ParamValues = Record<string, string | number | boolean>;

export interface MeshStats {
	triangles: number;
	size: [number, number, number];
	min: [number, number, number];
	volume: number;
}

export interface ModelVersion extends ModelVersionSummary {
	modelId: string;
	source: string;
	params: ParamValues;
	file: string;
}

/** GET /api/models/[id] */
export interface ModelDetail {
	model: Omit<ModelSummary, 'versions'>;
	versions: ModelVersion[];
	current: ModelVersion | undefined;
	parameters: Parameter[];
	editing: boolean;
}

/** POST /api/models/preview */
export interface PreviewResult {
	ok: boolean;
	diagnostics: Diagnostic[];
	echo: string[];
	ms: number;
	parameters: Parameter[];
	stats: MeshStats | null;
	stl: string | null;
}

/** An AI design or edit suggestion (nothing is saved until the user keeps it). */
export interface CadSuggestion {
	name?: string;
	summary: string;
	source: string;
	render: { ok: boolean; diagnostics: Diagnostic[]; echo: string[]; ms: number; triangles: number };
	attempts: number;
	/** Which AI answered, and how long it took. */
	provider: import('./integrations').AiProviderId;
	seconds: number;
}

// ---------- Text on a face (shared so the browser preview matches the server edit exactly) ----------

export const TEXT_FONTS = {
	bold: 'Liberation Sans:style=Bold',
	regular: 'Liberation Sans',
	mono: 'Liberation Mono'
} as const;
export type TextFont = keyof typeof TEXT_FONTS;

/**
 * OpenSCAD source for the letters, centred on the origin in the XY plane. Raised letters sink slightly
 * into the part so they fuse with it on gently curved faces; engraved ones reach a little above the
 * surface so the cut is clean.
 */
export function textScad(
	text: string,
	font: TextFont,
	size: number,
	depth: number,
	mode: 'emboss' | 'engrave'
) {
	const sink = mode === 'emboss' ? Math.min(2, size / 4) : depth;
	const rise = mode === 'emboss' ? depth : 1;
	// JSON.stringify gives a valid OpenSCAD string literal for printable text.
	return `$fn = 32; translate([0, 0, ${-sink}]) linear_extrude(height = ${sink + rise}) text(${JSON.stringify(text.trim())}, size = ${size}, font = ${JSON.stringify(TEXT_FONTS[font])}, halign = "center", valign = "center");`;
}

/**
 * Column-major 4×4 placement for letters on a face: they lie in the face plane, read correctly from
 * outside, stand upright on walls, and are turned by `angle` degrees about the face normal.
 */
export function textFrame(
	point: readonly number[],
	normal: readonly number[],
	angle: number
): number[] {
	const unit = (v: readonly number[]) => {
		const l = Math.hypot(v[0], v[1], v[2]) || 1;
		return [v[0] / l, v[1] / l, v[2] / l];
	};
	const n = unit(normal);
	const ref = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
	const d = ref[0] * n[0] + ref[1] * n[1] + ref[2] * n[2];
	let u =
		n[2] < -0.9 ? [0, -1, 0] : unit([ref[0] - d * n[0], ref[1] - d * n[1], ref[2] - d * n[2]]);
	let r = [u[1] * n[2] - u[2] * n[1], u[2] * n[0] - u[0] * n[2], u[0] * n[1] - u[1] * n[0]]; // u × n
	const a = (angle * Math.PI) / 180,
		c = Math.cos(a),
		s = Math.sin(a);
	[r, u] = [r.map((x, i) => x * c + u[i] * s), u.map((x, i) => x * c - r[i] * s)];
	return [
		r[0],
		r[1],
		r[2],
		0,
		u[0],
		u[1],
		u[2],
		0,
		n[0],
		n[1],
		n[2],
		0,
		point[0],
		point[1],
		point[2],
		1
	];
}
