// Print readiness: quick, slicer-free checks on a mesh so problems show up before a plate is wasted.
// Pure functions (no three.js) so they run in tests and on any page.

/** Build volume of the Bambu Lab X2D in mm. */
export const BED = { x: 256, y: 256, z: 260 };

export interface MeshFacts {
	/** Edges not shared by exactly two faces; null when the mesh is too dense to check quickly. */
	openEdges: number | null;
	/** Area (mm²) of the faces lying flat on the lowest point, i.e. what touches the plate. */
	contactArea: number;
}

const MAX_WELD = 400_000;

/** Counts open edges and measures the bed contact of a non-indexed triangle list. */
export function meshFacts(p: Float32Array): MeshFacts {
	const n = Math.floor(p.length / 9);
	let minZ = Infinity;
	for (let i = 2; i < n * 9; i += 3) minZ = Math.min(minZ, p[i]);
	let contactArea = 0;
	for (let i = 0; i < n; i++) {
		const o = i * 9;
		if (Math.max(p[o + 2], p[o + 5], p[o + 8]) - minZ > 0.05) continue;
		const ax = p[o + 3] - p[o],
			ay = p[o + 4] - p[o + 1],
			bx = p[o + 6] - p[o],
			by = p[o + 7] - p[o + 1];
		contactArea += Math.abs(ax * by - ay * bx) / 2;
	}
	if (n > MAX_WELD) return { openEdges: null, contactArea };

	// Weld corners that share a position (to 1/1000 mm), then count how many faces use each edge.
	// Open-addressing hash tables over typed arrays: ~10× faster than string keys on big meshes.
	const corners = n * 3;
	let size = 1;
	while (size < corners * 2) size <<= 1;
	const mask = size - 1;
	const keys = new Int32Array(size * 3);
	const slotId = new Int32Array(size).fill(-1);
	const vid = new Int32Array(corners);
	let nextId = 0;
	for (let v = 0; v < corners; v++) {
		const x = Math.round(p[v * 3] * 1000),
			y = Math.round(p[v * 3 + 1] * 1000),
			z = Math.round(p[v * 3 + 2] * 1000);
		let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & mask;
		for (;;) {
			const id = slotId[h];
			if (id === -1) {
				slotId[h] = vid[v] = nextId++;
				keys[h * 3] = x;
				keys[h * 3 + 1] = y;
				keys[h * 3 + 2] = z;
				break;
			}
			if (keys[h * 3] === x && keys[h * 3 + 1] === y && keys[h * 3 + 2] === z) {
				vid[v] = id;
				break;
			}
			h = (h + 1) & mask;
		}
	}
	let esize = 1;
	while (esize < corners * 2) esize <<= 1;
	const emask = esize - 1;
	const ea = new Int32Array(esize).fill(-1);
	const eb = new Int32Array(esize);
	const count = new Uint8Array(esize);
	for (let i = 0; i < n; i++) {
		for (let k = 0; k < 3; k++) {
			let a = vid[i * 3 + k],
				b = vid[i * 3 + ((k + 1) % 3)];
			if (a === b) continue;
			if (a > b) [a, b] = [b, a];
			let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663)) & emask;
			while (ea[h] !== -1 && (ea[h] !== a || eb[h] !== b)) h = (h + 1) & emask;
			if (ea[h] === -1) {
				ea[h] = a;
				eb[h] = b;
			}
			if (count[h] < 255) count[h]++;
		}
	}
	let openEdges = 0;
	for (let h = 0; h < esize; h++) if (ea[h] !== -1 && count[h] !== 2) openEdges++;
	return { openEdges, contactArea };
}

export type CheckLevel = 'ok' | 'warn' | 'fail';
export type CheckFix = 'fit' | 'orient' | 'overhangs' | 'repair';
export interface PrintCheck {
	id: 'bed' | 'base' | 'supports' | 'closed' | 'tiny';
	level: CheckLevel;
	title: string;
	detail: string;
	fixes: CheckFix[];
}

export interface CheckInput {
	size: [number, number, number];
	area: number;
	overhangArea: number;
	openEdges: number | null;
	contactArea: number;
}

const mm = (n: number) => (n < 10 ? n.toFixed(1) : Math.round(n).toString());
const cm2 = (a: number) =>
	a < 100 ? `${Math.round(a)} mm²` : `${(a / 100).toFixed(a < 1000 ? 1 : 0)} cm²`;

/** Turns measurements into a short list of plain-language checks, worst first. */
export function printChecks(m: CheckInput): PrintCheck[] {
	const [x, y, z] = m.size;
	const checks: PrintCheck[] = [];

	if (x > BED.x || y > BED.y || z > BED.z)
		checks.push({
			id: 'bed',
			level: 'fail',
			title: 'Too big for the printer',
			detail: `${mm(x)} × ${mm(y)} × ${mm(z)} mm; the X2D prints up to ${BED.x} × ${BED.y} × ${BED.z} mm.`,
			fixes: ['fit']
		});
	else
		checks.push({
			id: 'bed',
			level: 'ok',
			title: 'Fits on the plate',
			detail: `${mm(x)} × ${mm(y)} × ${mm(z)} mm of ${BED.x} × ${BED.y} × ${BED.z}`,
			fixes: []
		});

	if (Math.min(x, y, z) < 0.8)
		checks.push({
			id: 'tiny',
			level: 'warn',
			title: 'Very thin',
			detail: `At ${mm(Math.min(x, y, z))} mm it is thinner than two lines of plastic.`,
			fixes: []
		});

	const footprint = x * y;
	const contactShare = footprint ? m.contactArea / footprint : 0;
	if (m.contactArea < 25 || (contactShare < 0.04 && z > 10))
		checks.push({
			id: 'base',
			level: 'warn',
			title: 'Small base on the plate',
			detail: `Only ${cm2(m.contactArea)} touches the plate, so it may tip or come loose. Lay it on a flat face or add a brim.`,
			fixes: ['orient']
		});
	else
		checks.push({
			id: 'base',
			level: 'ok',
			title: 'Stands firmly',
			detail: `${cm2(m.contactArea)} touches the plate.`,
			fixes: []
		});

	const share = m.area ? m.overhangArea / m.area : 0;
	if (share > 0.01)
		checks.push({
			id: 'supports',
			level: share > 0.15 ? 'warn' : 'ok',
			title: share > 0.15 ? 'Needs supports' : 'A few spots need support',
			detail: `${cm2(m.overhangArea)} hangs over air (${Math.round(share * 100)} % of the surface).`,
			fixes: ['overhangs', 'orient']
		});
	else
		checks.push({
			id: 'supports',
			level: 'ok',
			title: 'No supports needed',
			detail: 'Nothing hangs out steeper than 45°.',
			fixes: ['overhangs']
		});

	if (m.openEdges !== null)
		checks.push(
			m.openEdges
				? {
						id: 'closed',
						level: 'warn',
						title: 'Has holes in the surface',
						detail: `${m.openEdges} open edge${m.openEdges === 1 ? '' : 's'}; the slicer may guess wrong about what is inside.`,
						fixes: ['repair']
					}
				: {
						id: 'closed',
						level: 'ok',
						title: 'Closed and solid',
						detail: 'Every edge is shared by two faces.',
						fixes: []
					}
		);

	const rank = { fail: 0, warn: 1, ok: 2 };
	return checks.sort((a, b) => rank[a.level] - rank[b.level]);
}

/** Uniform factor that makes a part fit the build volume with a small margin (1 when it fits). */
export function fitFactor(size: [number, number, number]): number {
	const f = Math.min(BED.x / size[0], BED.y / size[1], BED.z / size[2]) * 0.98;
	return f < 1 ? f : 1;
}

/**
 * A rough print time for the X2D at standard quality: material rate plus a per-layer cost.
 * Deliberately conservative; the slicer gives the real figure.
 */
export function roughMinutes(grams: number, height: number): number {
	return Math.max(5, Math.round(grams * 1.9 + (height / 0.2) * 0.05 + 4));
}
