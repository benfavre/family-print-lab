// Robust solid edits via Manifold (WebAssembly): transforms, lay flat, cut, drill, boolean combine.
import Module from 'manifold-3d';
import { AppError } from '../validation';
import { indexed, type Soup } from './mesh';
import { renderScad } from './openscad';
import { textFrame, textScad, type TextFont } from '$lib/shared/cad';
export { TEXT_FONTS, type TextFont } from '$lib/shared/cad';

type Wasm = Awaited<ReturnType<typeof Module>>;
type Manifold = InstanceType<Wasm['Manifold']>;
let wasmPromise: Promise<Wasm> | null = null;

function load(): Promise<Wasm> {
	wasmPromise ??= Module().then((w) => {
		w.setup();
		return w;
	});
	return wasmPromise;
}

function toManifold(w: Wasm, soup: Soup): Manifold {
	const { vertices, triangles } = indexed(soup);
	const mesh = new w.Mesh({ numProp: 3, vertProperties: vertices, triVerts: triangles });
	mesh.merge();
	try {
		return new w.Manifold(mesh);
	} catch {
		throw new AppError(
			422,
			'This mesh is not watertight, so solid edits are unsafe. Use “Repair in Blender” first.'
		);
	}
}

function toSoup(m: Manifold): Soup {
	const mesh = m.getMesh();
	const { numProp, vertProperties: v, triVerts: t } = mesh;
	const out = new Float32Array(t.length * 3);
	for (let i = 0; i < t.length; i++)
		for (let k = 0; k < 3; k++) out[i * 3 + k] = v[t[i] * numProp + k];
	return out;
}

/** Moves the part so it sits on the bed (z = 0), centered on x/y. */
function drop(m: Manifold): Manifold {
	const { min, max } = m.boundingBox();
	return m.translate([-(min[0] + max[0]) / 2, -(min[1] + max[1]) / 2, -min[2]]);
}

export type MeshOp =
	| { op: 'scale'; factor: [number, number, number] }
	| { op: 'rotate'; degrees: [number, number, number] }
	| { op: 'mirror'; axis: 'x' | 'y' | 'z' }
	| { op: 'center' }
	| { op: 'layFlat'; normal: [number, number, number] }
	| { op: 'autoOrient' }
	| { op: 'cut'; axis: 'x' | 'y' | 'z'; at: number; keep: 'below' | 'above' | 'both' }
	| { op: 'drill'; x: number; y: number; diameter: number }
	| { op: 'combine'; mode: 'union' | 'subtract' | 'intersect'; other: Soup }
	| {
			op: 'text';
			text: string;
			font: TextFont;
			size: number;
			depth: number;
			mode: 'emboss' | 'engrave';
			point: [number, number, number];
			normal: [number, number, number];
			angle: number;
	  }
	| { op: 'copies'; count: number; gap: number };

const BED = { x: 256, y: 256 };

const AXIS = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] } as const;

export async function applyOp(soup: Soup, op: MeshOp): Promise<Soup> {
	const w = await load();
	let m = toManifold(w, soup);
	switch (op.op) {
		case 'scale':
			if (op.factor.some((f) => !(f > 0.001 && f < 1000)))
				throw new AppError(400, 'Scale factors must be positive.');
			m = drop(m.scale(op.factor));
			break;
		case 'rotate':
			m = drop(m.rotate(op.degrees));
			break;
		case 'mirror':
			m = drop(m.mirror([...AXIS[op.axis]] as [number, number, number]));
			break;
		case 'center':
			m = drop(m);
			break;
		case 'autoOrient':
		case 'layFlat':
			m = drop(layDown(m, op.op === 'layFlat' ? op.normal : bestDownDirection(soup)));
			break;
		case 'cut': {
			const normal = [...AXIS[op.axis]] as [number, number, number];
			if (op.keep === 'both') {
				// Both pieces side by side on one plate.
				const [upper, lower] = m.splitByPlane(normal, op.at);
				if (upper.isEmpty() || lower.isEmpty())
					throw new AppError(400, 'That plane does not cut through the part.');
				// Each piece rests on its best flat face: usually the fresh cut, or the original base if that is bigger.
				const a = drop(layDown(lower, bestDownDirection(toSoup(lower))));
				const b = drop(layDown(upper, bestDownDirection(toSoup(upper))));
				const wa = a.boundingBox().max[0] - a.boundingBox().min[0];
				const wb = b.boundingBox().max[0] - b.boundingBox().min[0];
				const gap = 5;
				m = drop(
					w.Manifold.compose([
						a.translate([-(wb + gap) / 2, 0, 0]),
						b.translate([(wa + gap) / 2, 0, 0])
					])
				);
				const box = m.boundingBox();
				if (box.max[0] - box.min[0] > BED.x || box.max[1] - box.min[1] > BED.y)
					throw new AppError(
						400,
						'Both pieces side by side would not fit on the bed. Keep one side at a time instead.'
					);
				break;
			}
			m =
				op.keep === 'below'
					? m.trimByPlane(normal.map((v) => -v) as [number, number, number], -op.at)
					: m.trimByPlane(normal, op.at);
			if (m.isEmpty()) throw new AppError(400, 'Nothing would be left after that cut.');
			m = drop(m);
			break;
		}
		case 'drill': {
			if (!(op.diameter > 0.1 && op.diameter < 500))
				throw new AppError(400, 'Hole diameter must be between 0.1 and 500 mm.');
			const { min, max } = m.boundingBox();
			const tool = w.Manifold.cylinder(
				max[2] - min[2] + 2,
				op.diameter / 2,
				op.diameter / 2,
				64
			).translate([op.x, op.y, min[2] - 1]);
			m = m.subtract(tool);
			break;
		}
		case 'combine': {
			const other = toManifold(w, op.other);
			m = drop(
				op.mode === 'union'
					? m.add(other)
					: op.mode === 'subtract'
						? m.subtract(other)
						: m.intersect(other)
			);
			if (m.isEmpty()) throw new AppError(400, 'That combination leaves nothing.');
			break;
		}
		case 'text': {
			const glyphs = await textSolid(w, op);
			m = op.mode === 'emboss' ? m.add(glyphs) : m.subtract(glyphs);
			m = drop(m);
			break;
		}
		case 'copies': {
			if (!(Number.isInteger(op.count) && op.count >= 2 && op.count <= 36))
				throw new AppError(400, 'Choose between 2 and 36 copies.');
			if (!(op.gap >= 0 && op.gap <= 100))
				throw new AppError(400, 'The gap must be between 0 and 100 mm.');
			m = drop(m);
			const { min, max } = m.boundingBox();
			const [sx, sy] = [max[0] - min[0], max[1] - min[1]];
			// A near-square grid, with more columns than rows when the part is tall in Y.
			const cols = Math.ceil(Math.sqrt((op.count * sy) / Math.max(sx, 0.1)));
			const c = Math.min(op.count, Math.max(1, cols));
			const rows = Math.ceil(op.count / c);
			const width = c * sx + (c - 1) * op.gap,
				depth = rows * sy + (rows - 1) * op.gap;
			if (width > BED.x || depth > BED.y)
				throw new AppError(
					400,
					`${op.count} copies need ${Math.round(width)} × ${Math.round(depth)} mm, more than the 256 × 256 mm bed. Try fewer copies or a smaller gap.`
				);
			const parts: Manifold[] = [];
			for (let i = 0; i < op.count; i++)
				parts.push(m.translate([(i % c) * (sx + op.gap), Math.floor(i / c) * (sy + op.gap), 0]));
			m = drop(w.Manifold.compose(parts));
			break;
		}
	}
	return toSoup(m);
}

/**
 * Letters as a solid, placed on a face: the text lies in the face plane, reads correctly from outside,
 * and stands upright on walls. Embossed letters sink slightly into the part so they fuse with it on
 * gently curved faces; engraved ones reach a little above the surface so the cut is clean.
 */
async function textSolid(w: Wasm, op: Extract<MeshOp, { op: 'text' }>): Promise<Manifold> {
	const text = op.text.trim();
	if (!text || text.length > 60 || [...text].some((ch) => ch.charCodeAt(0) < 32))
		throw new AppError(400, 'Text must be 1–60 characters on one line.');
	if (!(op.size >= 2 && op.size <= 200))
		throw new AppError(400, 'Letter height must be between 2 and 200 mm.');
	if (!(op.depth >= 0.2 && op.depth <= 20))
		throw new AppError(400, 'Depth must be between 0.2 and 20 mm.');
	const render = await renderScad(textScad(text, op.font, op.size, op.depth, op.mode));
	if (!render.soup) throw new AppError(400, 'Could not make letters from that text.');
	return toManifold(w, render.soup).transform(textFrame(op.point, op.normal, op.angle) as Mat4);
}

type Mat4 = Parameters<Manifold['transform']>[0];

/** Rotates the part so the given direction (e.g. a face normal) points straight down. */
function layDown(m: Manifold, normal: readonly number[]): Manifold {
	const [nx, ny, nz] = normal.map((v) => v / (Math.hypot(normal[0], normal[1], normal[2]) || 1));
	const axis = [-ny, nx, 0]; // normal × (0, 0, -1)
	const angle = (Math.acos(Math.max(-1, Math.min(1, -nz))) * 180) / Math.PI;
	const len = Math.hypot(axis[0], axis[1]);
	if (len > 1e-6 && angle > 0.01)
		return m.transform(rotationMatrix(axis[0] / len, axis[1] / len, 0, angle));
	return nz > 0 ? m.rotate([180, 0, 0]) : m;
}

/** Column-major 4x4 matrix (Manifold's Mat4) for a rotation of `deg` degrees about the unit axis (x, y, z). */
function rotationMatrix(x: number, y: number, z: number, deg: number) {
	const a = (deg * Math.PI) / 180,
		c = Math.cos(a),
		s = Math.sin(a),
		t = 1 - c;
	// prettier-ignore
	return [
		t * x * x + c,     t * x * y + s * z, t * x * z - s * y, 0,
		t * x * y - s * z, t * y * y + c,     t * y * z + s * x, 0,
		t * x * z + s * y, t * y * z - s * x, t * z * z + c,     0,
		0,                 0,                 0,                 1
	] as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];
}

/** Checks whether a mesh is a valid closed solid. */
export async function isSolid(soup: Soup): Promise<boolean> {
	const w = await load();
	try {
		toManifold(w, soup);
		return true;
	} catch {
		return false;
	}
}

/**
 * Picks the print orientation needing the least support: tries the part's larger flat faces (and the six
 * axis directions) as the bottom, and scores each by overhang area (faces steeper than 45° that are not on
 * the bed), preferring more contact with the bed and then a lower part. Returns the face normal to put down.
 */
export function bestDownDirection(soup: Soup): [number, number, number] {
	const n = soup.length / 9;
	const normals = new Float32Array(n * 3);
	const areas = new Float32Array(n);
	const clusters = new Map<string, { n: [number, number, number]; area: number }>();
	for (let i = 0; i < n; i++) {
		const o = i * 9;
		const ax = soup[o + 3] - soup[o],
			ay = soup[o + 4] - soup[o + 1],
			az = soup[o + 5] - soup[o + 2];
		const bx = soup[o + 6] - soup[o],
			by = soup[o + 7] - soup[o + 1],
			bz = soup[o + 8] - soup[o + 2];
		const cx = ay * bz - az * by,
			cy = az * bx - ax * bz,
			cz = ax * by - ay * bx;
		const len = Math.hypot(cx, cy, cz);
		if (!len) continue;
		normals.set([cx / len, cy / len, cz / len], i * 3);
		areas[i] = len / 2;
		const key = [cx, cy, cz].map((c) => Math.round((c / len) * 40)).join(',');
		const cluster = clusters.get(key);
		if (cluster) cluster.area += len / 2;
		else clusters.set(key, { n: [cx / len, cy / len, cz / len], area: len / 2 });
	}
	const candidates: [number, number, number][] = [
		...[...clusters.values()]
			.sort((a, b) => b.area - a.area)
			.slice(0, 24)
			.map((c) => c.n),
		[0, 0, -1],
		[0, 0, 1],
		[1, 0, 0],
		[-1, 0, 0],
		[0, 1, 0],
		[0, -1, 0]
	];
	const limit = Math.cos(Math.PI / 4);
	let best = candidates[0],
		bestScore = Infinity;
	for (const d of candidates) {
		// Along d ("down"), the bed is at the largest projection.
		let bed = -Infinity,
			low = Infinity;
		for (let i = 0; i < soup.length; i += 3) {
			const p = soup[i] * d[0] + soup[i + 1] * d[1] + soup[i + 2] * d[2];
			if (p > bed) bed = p;
			if (p < low) low = p;
		}
		let overhang = 0,
			contact = 0;
		for (let i = 0; i < n; i++) {
			const dot = normals[i * 3] * d[0] + normals[i * 3 + 1] * d[1] + normals[i * 3 + 2] * d[2];
			if (dot <= limit) continue;
			const o = i * 9;
			let top = Infinity;
			for (let v = 0; v < 3; v++)
				top = Math.min(
					top,
					soup[o + v * 3] * d[0] + soup[o + v * 3 + 1] * d[1] + soup[o + v * 3 + 2] * d[2]
				);
			if (top >= bed - 0.3) contact += areas[i];
			else overhang += areas[i];
		}
		const score = overhang - 0.5 * contact + 0.001 * (bed - low);
		if (score < bestScore - 1e-6) {
			bestScore = score;
			best = d;
		}
	}
	return best;
}
