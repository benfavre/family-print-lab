// Facet painting codec: the per-triangle strings Bambu Studio writes as paint_supports, paint_seam,
// paint_color and paint_fuzzy_skin in a 3MF. A port of the (de)serialisation in upstream's
// TriangleSelector::serialize()/deserialize() (src/libslic3r/TriangleSelector.cpp) and
// FacetsAnnotation::get_triangle_as_string()/set_triangle_from_string() (src/libslic3r/Model.cpp,
// Bambu Studio at the tag in slicer/upstream.lock).
//
// Each original triangle is either a leaf with a state, or split into 2–4 children (recursively).
// The bit stream is a sequence of 4-bit codes: bits 0–1 hold the number of split sides (0 = leaf),
// bits 2–3 the special side (split) or the state (leaf, 0–2). A leaf with state ≥ 3 writes 0b1100,
// then 0b1111 for every 15 above 3, then the rest. Children are written last child first (kept for
// compatibility with PrusaSlicer 2.3.1). The string is the nibbles as hex digits, last nibble first.
//
// origin: BambuStudio src/libslic3r/TriangleSelector.cpp, src/libslic3r/Model.cpp @
//   926a7192574bcb9b3a732e1ec59a46d79cb45466

/** Painting states: 0 none; supports/seam 1 = enforcer, 2 = blocker; colour n = filament n; fuzzy skin 1. */
export type PaintState = number;
export const PAINT_NONE = 0;
export const PAINT_ENFORCER = 1;
export const PAINT_BLOCKER = 2;

/** One triangle of the subdivision tree; `children` in upstream's child order (0 first). */
export type PaintNode =
	{ state: PaintState } | { split: 1 | 2 | 3; special: 0 | 1 | 2 | 3; children: PaintNode[] };

export class PaintCodecError extends Error {}

const HEX = '0123456789ABCDEF';

/** Decodes one triangle's string (as found in the 3MF attribute) into its tree. */
export function decodePaint(hex: string): PaintNode {
	if (!/^[0-9A-Fa-f]+$/.test(hex)) throw new PaintCodecError('Not a painting string.');
	// The string holds the last nibble first.
	const nibbles: number[] = [];
	for (let i = hex.length - 1; i >= 0; i--) nibbles.push(parseInt(hex[i], 16));
	let pos = 0;
	const next = () => {
		if (pos >= nibbles.length) throw new PaintCodecError('Painting string ends early.');
		return nibbles[pos++];
	};
	const read = (depth: number): PaintNode => {
		if (depth > 64) throw new PaintCodecError('Painting string is nested too deeply.');
		const code = next();
		const split = code & 0b11;
		if (split) {
			const reversed: PaintNode[] = [];
			for (let c = split; c >= 0; c--) reversed.push(read(depth + 1));
			return {
				split: split as 1 | 2 | 3,
				special: (code >> 2) as 0 | 1 | 2 | 3,
				children: reversed.reverse()
			};
		}
		if ((code & 0b1100) === 0b1100) {
			let n = next();
			let fifteens = 0;
			while (n === 0b1111) {
				fifteens++;
				n = next();
			}
			return { state: n + 15 * fifteens + 3 };
		}
		return { state: code >> 2 };
	};
	const node = read(0);
	// Upstream stores whole nibbles only; anything left over is not ours to drop silently.
	if (pos !== nibbles.length) throw new PaintCodecError('Painting string has trailing data.');
	return node;
}

/** Encodes a tree back into the string upstream writes (upper-case hex). */
export function encodePaint(node: PaintNode): string {
	const nibbles: number[] = [];
	const write = (n: PaintNode, depth: number) => {
		if (depth > 64) throw new PaintCodecError('Painting tree is nested too deeply.');
		if ('split' in n) {
			if (n.children.length !== n.split + 1)
				throw new PaintCodecError('A split triangle needs one more child than split sides.');
			nibbles.push(n.split | (n.special << 2));
			for (let c = n.split; c >= 0; c--) write(n.children[c], depth + 1);
			return;
		}
		const state = n.state;
		if (!Number.isInteger(state) || state < 0) throw new PaintCodecError('Bad painting state.');
		if (state < 3) nibbles.push(state << 2);
		else {
			nibbles.push(0b1100);
			let rest = state - 3;
			while (rest >= 15) {
				nibbles.push(0b1111);
				rest -= 15;
			}
			nibbles.push(rest);
		}
	};
	write(node, 0);
	let out = '';
	for (let i = nibbles.length - 1; i >= 0; i--) out += HEX[nibbles[i]];
	return out;
}

/** The string for a whole triangle painted with one state ('' for none: upstream omits the attribute). */
export function paintTriangle(state: PaintState): string {
	return state === PAINT_NONE ? '' : encodePaint({ state });
}

/** Every state used in a tree (for example the filaments a colour painting needs). */
export function paintStates(node: PaintNode, into = new Set<PaintState>()): Set<PaintState> {
	if ('split' in node) for (const c of node.children) paintStates(c, into);
	else into.add(node.state);
	return into;
}

/** A tree with every leaf in state `from` set to `to`; merges split triangles whose leaves all match. */
export function replacePaintState(node: PaintNode, from: PaintState, to: PaintState): PaintNode {
	if (!('split' in node)) return node.state === from ? { state: to } : node;
	const children = node.children.map((c) => replacePaintState(c, from, to));
	const first = children[0];
	if (children.every((c) => !('split' in c) && !('split' in first) && c.state === first.state))
		return first;
	return { ...node, children };
}
