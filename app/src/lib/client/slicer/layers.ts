// Variable layer height, as Bambu Studio's layer height editor does it: an object's
// layer_height_profile is a list of z, layer height pairs that the slicer interpolates between. Ported
// from upstream libslic3r/Slicing.cpp (SlicingParameters::create_from_config,
// layer_height_profile_from_ranges, layer_height_profile_adaptive, smooth_height_profile,
// adjust_layer_height_profile, generate_object_layers), SlicingAdaptive.cpp and the profile checks of
// PrintObject::update_layer_height_profile (https://github.com/bambulab/BambuStudio, AGPL-3.0).
import type { ConfigMap, ConfigValue, HeightRange, SceneObject } from '$lib/shared/slicer/project';
import type { MeshSource } from './edit';
import { compose } from './matrix';

/** libslic3r.h EPSILON. */
const EPSILON = 1e-4;
const MIN_LAYER_HEIGHT = 0.01;
const MIN_LAYER_HEIGHT_DEFAULT = 0.07;
/** BBS: the adaptive profile changes by at most this much from one layer to the next. */
const LAYER_HEIGHT_CHANGE_STEP = 0.04;

/** The part of upstream's SlicingParameters the editor needs. */
export interface SlicingParams {
	layerHeight: number;
	/** first_object_layer_height. */
	firstLayerHeight: number;
	/** first_object_layer_height_fixed(): no raft under the object. */
	firstLayerFixed: boolean;
	minLayerHeight: number;
	maxLayerHeight: number;
	/** object_print_z_height(): the profile runs from 0 to here (a raft is not counted). */
	objectHeight: number;
}

const lerp = (a: number, b: number, t: number) => (1 - t) * a + t * b;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A number from a config value (per-extruder values: the first nozzle's), NaN when absent. */
function num(v: ConfigValue | undefined): number {
	const x = Array.isArray(v) ? v[0] : v;
	return x === undefined || x === '' ? NaN : parseFloat(x);
}

/**
 * The slicing parameters of an object from its flattened config (presets plus the object's own
 * settings) and its height on the bed. Nozzle limits are the first nozzle's, as on single-nozzle
 * printers (upstream takes the most restrictive of the object's extruders).
 */
export function slicingParams(config: ConfigMap, objectHeight: number): SlicingParams {
	const layerHeight = num(config.layer_height) > 0 ? num(config.layer_height) : 0.2;
	const initial = num(config.initial_layer_print_height);
	const raft = Math.max(0, Math.round(num(config.raft_layers)) || 0);
	const minSetting = num(config.min_layer_height) || 0;
	const minNozzle =
		minSetting === 0 ? MIN_LAYER_HEIGHT_DEFAULT : Math.max(MIN_LAYER_HEIGHT, minSetting);
	const maxSetting = num(config.max_layer_height) || 0;
	const nozzle = num(config.nozzle_diameter) > 0 ? num(config.nozzle_diameter) : 0.4;
	const maxNozzle = Math.max(minNozzle, maxSetting === 0 ? 0.75 * nozzle : maxSetting);
	return {
		layerHeight,
		// With a raft the first object layer is an ordinary one (create_from_config).
		firstLayerHeight: raft > 0 ? layerHeight : initial > 0 ? initial : layerHeight,
		firstLayerFixed: raft === 0,
		minLayerHeight: Math.min(Math.max(MIN_LAYER_HEIGHT, minNozzle), layerHeight),
		maxLayerHeight: Math.max(maxNozzle, layerHeight),
		objectHeight
	};
}

/**
 * The profile the slicer uses when the object has none: the layer height, the fixed first layer and
 * each height range's own layer height (layer_height_profile_from_ranges).
 */
export function profileFromRanges(p: SlicingParams, ranges: HeightRange[]): number[] {
	const spans: [number, number, number][] = [];
	if (p.firstLayerFixed) spans.push([0, p.firstLayerHeight, p.firstLayerHeight]);
	const sorted = [...ranges].sort((a, b) => a.minZ - b.minZ || a.maxZ - b.maxZ);
	for (const r of sorted) {
		let lo = r.minZ;
		const hi = Math.min(r.maxZ, p.objectHeight);
		const own = num(r.config.layer_height);
		if (spans.length) lo = Math.max(lo, spans[spans.length - 1][1]);
		if (lo + EPSILON < hi) spans.push([lo, hi, own > 0 ? own : p.layerHeight]);
	}
	const out: number[] = [];
	const approx = (a: number, b: number) => Math.abs(a - b) < EPSILON;
	const lastZ = () => (out.length ? out[out.length - 2] : 0);
	const append = (z: number, h: number) => {
		if (out.length && approx(out[out.length - 1], h)) {
			if (approx(out[out.length - 2], z)) return;
			if (out.length >= 4 && approx(out[out.length - 3], h)) {
				// A third point at the same height only moves the last one up.
				out[out.length - 2] = z;
				return;
			}
		}
		out.push(z, h);
	};
	for (const [lo, hi, h] of spans) {
		const z = lastZ();
		if (lo > z + EPSILON) {
			append(z, p.layerHeight);
			append(lo, p.layerHeight);
		}
		append(lo, h);
		append(hi, h);
	}
	const z = lastZ();
	if (z < p.objectHeight) {
		append(z, p.layerHeight);
		append(p.objectHeight, p.layerHeight);
	}
	return out;
}

/**
 * Why the slicer would ignore a stored profile and use profileFromRanges instead (the checks of
 * PrintObject::update_layer_height_profile), or null when it is used as it is.
 */
export function profileProblem(profile: number[], p: SlicingParams): string | null {
	if (profile.length < 4 || profile.length % 2) return 'The layer height profile is damaged.';
	if (Math.abs(profile[profile.length - 2] - p.objectHeight) > 1e-3)
		return 'The object’s height changed since the layer heights were set.';
	for (let i = 1; i < profile.length; i += 2)
		if (profile[i] < p.minLayerHeight - EPSILON || profile[i] > p.maxLayerHeight + EPSILON)
			return 'Some layer heights are outside what this nozzle can print.';
	if (p.firstLayerFixed && profile[1] !== p.firstLayerHeight)
		return 'The first layer height changed since the layer heights were set.';
	return null;
}

/** The profile the slicer will use: the stored one when it still fits, else the one from ranges. */
export function effectiveProfile(
	stored: number[] | undefined,
	ranges: HeightRange[],
	p: SlicingParams
): number[] {
	return stored?.length && !profileProblem(stored, p) ? stored : profileFromRanges(p, ranges);
}

/** The layer height the profile gives at z (linear between points, as generate_object_layers reads it). */
export function heightAt(profile: number[], z: number): number {
	if (profile.length < 2) return NaN;
	let i = 0;
	while (i + 2 < profile.length && z >= profile[i + 2]) i += 2;
	const next = i + 2;
	if (next >= profile.length || profile[next] === profile[i]) return profile[i + 1];
	return lerp(profile[i + 1], profile[next + 1], (z - profile[i]) / (profile[next] - profile[i]));
}

/** The layers the slicer cuts from a profile, as [bottom, top] pairs (generate_object_layers). */
export function objectLayers(p: SlicingParams, profile: number[]): [number, number][] {
	const out: [number, number][] = [];
	let printZ = 0;
	if (p.firstLayerFixed) {
		printZ = p.firstLayerHeight;
		out.push([0, printZ]);
	}
	let idx = 0;
	let sliceZ = printZ + 0.5 * p.minLayerHeight;
	while (sliceZ < p.objectHeight) {
		let height = p.minLayerHeight;
		if (idx < profile.length) {
			let next = idx + 2;
			while (next < profile.length && sliceZ >= profile[next]) {
				idx = next;
				next += 2;
			}
			const z1 = profile[idx],
				h1 = profile[idx + 1];
			height = h1;
			if (next < profile.length)
				height = lerp(h1, profile[next + 1], (sliceZ - z1) / (profile[next] - z1));
		}
		sliceZ = printZ + 0.5 * height;
		if (sliceZ >= p.objectHeight || !(height > 0)) break;
		out.push([printZ, printZ + height]);
		printZ += height;
		sliceZ = printZ + 0.5 * p.minLayerHeight;
	}
	return out;
}

// ---------- Adaptive (SlicingAdaptive.cpp) ----------

interface FaceZ {
	lo: number;
	hi: number;
	/** |normal z| and the length of the normal's xy part. */
	cos: number;
	sin: number;
}

/** Triangles (x y z per vertex) as their z spans and slopes, sorted by span (SlicingAdaptive::prepare). */
export function facesOf(positions: Float32Array): FaceZ[] {
	const faces: FaceZ[] = [];
	for (let t = 0; t + 8 < positions.length; t += 9) {
		const ax = positions[t + 3] - positions[t],
			ay = positions[t + 4] - positions[t + 1],
			az = positions[t + 5] - positions[t + 2];
		const bx = positions[t + 6] - positions[t],
			by = positions[t + 7] - positions[t + 1],
			bz = positions[t + 8] - positions[t + 2];
		const nx = ay * bz - az * by,
			ny = az * bx - ax * bz,
			nz = ax * by - ay * bx;
		const len = Math.hypot(nx, ny, nz) || 1;
		const zs = [positions[t + 2], positions[t + 5], positions[t + 8]];
		faces.push({
			lo: Math.min(...zs),
			hi: Math.max(...zs),
			cos: Math.abs(nz / len),
			sin: Math.hypot(nx, ny) / len
		});
	}
	return faces.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
}

/**
 * An object's model triangles as its first instance stands (SlicingAdaptive::prepare takes the raw
 * mesh under the first instance), lowest point at 0; null while a mesh is not loaded.
 */
export function objectTriangles(obj: SceneObject, meshes: MeshSource): Float32Array | null {
	const inst = obj.instances[0];
	const parts = obj.parts.filter((p) => p.type === 'model');
	if (!inst || !parts.length) return null;
	const chunks: Float32Array[] = [];
	for (const part of parts) {
		const src = meshes(part.mesh);
		if (!src) return null;
		const t = compose(part.transform, inst.transform);
		const out = new Float32Array(src.length);
		for (let i = 0; i < src.length; i += 3) {
			const x = src[i],
				y = src[i + 1],
				z = src[i + 2];
			out[i] = x * t[0] + y * t[3] + z * t[6];
			out[i + 1] = x * t[1] + y * t[4] + z * t[7];
			out[i + 2] = x * t[2] + y * t[5] + z * t[8];
		}
		chunks.push(out);
	}
	const all = new Float32Array(chunks.reduce((a, c) => a + c.length, 0));
	let at = 0;
	let minZ = Number.POSITIVE_INFINITY;
	for (const c of chunks) {
		all.set(c, at);
		at += c.length;
	}
	for (let i = 2; i < all.length; i += 3) minZ = Math.min(minZ, all[i]);
	for (let i = 2; i < all.length; i += 3) all[i] -= minZ;
	return all;
}

/** The tallest layer a facet allows for a surface deviation (the triangle area error metric, clamped). */
function slopeHeight(f: FaceZ, deviation: number): number {
	return Math.min(
		deviation / 0.184,
		f.cos > 1e-5 ? 1.44 * deviation * Math.sqrt(f.sin / f.cos) : Number.POSITIVE_INFINITY
	);
}

function nextLayerHeight(
	p: SlicingParams,
	faces: FaceZ[],
	printZ: number,
	quality: number,
	cursor: { at: number }
): number {
	let height = p.maxLayerHeight;
	const deviation =
		quality < 0.5
			? lerp(p.minLayerHeight, p.layerHeight, 2 * quality)
			: lerp(p.maxLayerHeight, p.layerHeight, 2 * (1 - quality));
	let id = cursor.at;
	let firstHit = false;
	for (; id < faces.length; id++) {
		const f = faces[id];
		if (f.lo >= printZ) break;
		if (f.hi > printZ) {
			if (!firstHit) {
				firstHit = true;
				cursor.at = id;
			}
			// Facets that only touch the layer would give tiny heights.
			if (f.hi < printZ + EPSILON) continue;
			height = Math.min(height, slopeHeight(f, deviation));
		}
	}
	height = Math.max(height, p.minLayerHeight);
	if (height > p.minLayerHeight) {
		// Sloped facets that start inside the proposed layer.
		for (; id < faces.length; id++) {
			const f = faces[id];
			if (f.lo >= printZ + height) break;
			if (f.hi < printZ + EPSILON) continue;
			const reduced = slopeHeight(f, deviation);
			const zDiff = f.lo - printZ;
			if (reduced < zDiff) height = zDiff;
			else if (reduced < height) height = reduced;
		}
		height = Math.max(height, p.minLayerHeight);
	}
	return height;
}

/**
 * Layer heights that follow the object's slopes (layer_height_profile_adaptive). `positions` are the
 * object's model triangles on the bed (lowest point at 0); `quality` 0 prints finest, 1 fastest.
 */
export function adaptiveProfile(
	p: SlicingParams,
	positions: Float32Array,
	quality = 0.5
): number[] {
	const faces = facesOf(positions);
	const out = [0, p.firstLayerHeight];
	if (p.firstLayerFixed) out.push(p.firstLayerHeight, p.firstLayerHeight);
	let printZ = p.firstLayerHeight;
	const cursor = { at: 0 };
	while (printZ + EPSILON < p.objectHeight) {
		let height = Math.min(nextLayerHeight(p, faces, printZ, quality, cursor), p.maxLayerHeight);
		// BBS: no steep changes from one layer to the next.
		const last = out[out.length - 1];
		if (last < height && height - last > LAYER_HEIGHT_CHANGE_STEP)
			height = last + LAYER_HEIGHT_CHANGE_STEP;
		else if (last > height && last - height > LAYER_HEIGHT_CHANGE_STEP)
			height = last - LAYER_HEIGHT_CHANGE_STEP;
		out.push(printZ, height);
		printZ += height;
	}
	const gap = p.objectHeight - out[out.length - 2];
	if (gap > 0) out.push(p.objectHeight, clamp(gap, p.minLayerHeight, p.maxLayerHeight));
	return out;
}

// ---------- Smoothing and the brush ----------

/** Smooths a whole profile (smooth_height_profile: six rounds of a biased Gaussian blur). */
export function smoothProfile(
	profile: number[],
	p: SlicingParams,
	o: { radius?: number; keepMin?: boolean } = {}
): number[] {
	const radius = Math.max(1, Math.round(o.radius ?? 5));
	const sigma = 0.3 * (radius - 1) + 0.8;
	const twoSqSigma = 2 * sigma * sigma;
	const norm = 1 / Math.sqrt(Math.PI * twoSqSigma);
	const kernel = Array.from({ length: 2 * radius + 1 }, (_, i) => {
		const x = i - radius;
		return norm * Math.exp((-x * x) / twoSqSigma);
	});
	const skip = p.firstLayerFixed ? 4 : 0;
	const deltaH = p.maxLayerHeight - p.minLayerHeight;
	const invDeltaH = deltaH !== 0 ? 1 / deltaH : 1;
	const maxBand = radius * p.layerHeight;
	const blur = (src: number[]): number[] => {
		if (src.length - skip < 6) return src;
		const out = src.slice(0, skip);
		for (let i = skip; i < src.length; i += 2) {
			const zi = src[i],
				hi = src[i + 1];
			const begin = Math.max(i - 2 * radius, skip),
				end = Math.min(i + 2 * radius, src.length - 2);
			let height = 0,
				total = 0;
			for (let j = begin; j <= end; j += 2) {
				// Upstream compares dz scaled by the layer height with the band; kept as it is.
				if (Math.abs(zi - src[j]) * p.layerHeight <= maxBand) {
					const dh = Math.abs(p.maxLayerHeight - src[j + 1]);
					const weight = kernel[radius + (j - i) / 2] * Math.sqrt(dh * invDeltaH);
					height += weight * src[j + 1];
					total += weight;
				}
			}
			height = clamp(total === 0 ? hi : height / total, p.minLayerHeight, p.maxLayerHeight);
			out.push(zi, o.keepMin ? Math.min(height, hi) : height);
		}
		return out;
	};
	let out = profile;
	for (let round = 0; round < 6; round++) out = blur(out);
	return out;
}

export type LayerEdit = 'increase' | 'decrease' | 'reduce' | 'smooth';

/**
 * One brush step of the layer height editor at z (adjust_layer_height_profile): thicker or thinner
 * layers, back towards the layer height, or smoother, fading out over `band` mm around z.
 */
export function adjustProfile(
	p: SlicingParams,
	profile: number[],
	z: number,
	delta: number,
	band: number,
	action: LayerEdit
): number[] {
	const spanLo = p.firstLayerFixed ? p.firstLayerHeight : 0,
		spanHi = p.objectHeight;
	if (z < spanLo || z > spanHi || profile.length < 4) return profile;

	// 1) The layer height at z now.
	let current = p.layerHeight;
	for (let i = 0; i < profile.length; i += 2) {
		if (i + 2 === profile.length) {
			current = profile[i + 1];
			break;
		}
		if (profile[i + 2] > z) {
			current = lerp(
				profile[i + 1],
				profile[i + 3],
				(z - profile[i]) / (profile[i + 2] - profile[i])
			);
			break;
		}
	}

	// 2) How much of the change fits.
	if (action === 'increase' || action === 'decrease') {
		if (action === 'decrease') delta = -delta;
		if (delta > 0) {
			if (current >= p.maxLayerHeight - EPSILON) return profile;
			delta = Math.min(delta, p.maxLayerHeight - current);
		} else {
			if (current <= p.minLayerHeight + EPSILON) return profile;
			delta = Math.max(delta, p.minLayerHeight - current);
		}
	} else {
		delta = Math.min(Math.abs(delta), Math.abs(p.layerHeight - current));
		if (delta < EPSILON) return profile;
	}

	// 3) Resample the band every 0.1 mm and change it there.
	const lo = Math.max(spanLo, z - 0.5 * band),
		hi = z + 0.5 * band;
	let idx = 0;
	while (idx < profile.length && profile[idx] < lo) idx += 2;
	// Upstream would step before the first point when the band starts at 0 (only with a raft).
	idx = Math.max(0, idx - 2);
	const out = profile.slice(0, idx + 2);
	const start = out.length;
	let zz = lo;
	while (zz < hi) {
		const next = idx + 2;
		const z1 = profile[idx],
			h1 = profile[idx + 1];
		let height = h1;
		if (next < profile.length && profile[next] !== z1)
			height = lerp(h1, profile[next + 1], (zz - z1) / (profile[next] - z1));
		const weight =
			Math.abs(zz - z) < 0.5 * band ? 0.5 + 0.5 * Math.cos((2 * Math.PI * (zz - z)) / band) : 0;
		if (action === 'increase' || action === 'decrease') height += weight * delta;
		else if (action === 'reduce') {
			const d = height - p.layerHeight;
			const step = weight * delta;
			height += Math.abs(d) > step ? (d > 0 ? -step : step) : -d;
		}
		height = clamp(height, p.minLayerHeight, p.maxLayerHeight);
		if (zz === spanHi) {
			// The profile's top point.
			if (out[out.length - 2] + EPSILON > zz) out.length -= 2;
			out.push(zz, height);
			idx = profile.length;
			break;
		}
		// No segments too short to matter.
		if (out[out.length - 2] + EPSILON < zz) out.push(zz, height);
		zz = Math.min(zz + 0.1, spanHi);
		idx = next;
		while (idx < profile.length && profile[idx] < zz) idx += 2;
		idx -= 2;
	}
	idx += 2;
	let end = out.length;
	if (idx < profile.length) out.push(...profile.slice(idx));
	else if (out[out.length - 2] + 0.5 * EPSILON < spanHi) out.push(...profile.slice(-2));

	if (action === 'smooth') {
		if (end === out.length) end -= 2;
		for (let round = 0; round < 6; round++) {
			const prev = out.slice();
			for (let i = start; i < end; i += 2) {
				const t =
					Math.abs(prev[i] - z) < 0.5 * band
						? 0.25 + 0.25 * Math.cos((2 * Math.PI * (prev[i] - z)) / band)
						: 0;
				out[i + 1] =
					i === 0
						? (1 - t) * prev[i + 1] + t * prev[i + 3]
						: (1 - t) * prev[i + 1] + 0.5 * t * (prev[i - 1] + prev[i + 3]);
			}
		}
	}
	return out;
}

/** A profile with its numbers rounded for the file (upstream writes them with %g-like precision). */
export function roundProfile(profile: number[]): number[] {
	return profile.map((v) => Math.round(v * 1e5) / 1e5);
}
