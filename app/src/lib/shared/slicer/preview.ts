// The toolpath preview format: one binary container, produced both by the TypeScript G-code parser
// (gcode-preview) and by the engine (`preview.get`), decoded once in the browser. Little-endian:
//
//   offset 0   "PLPV"                 magic, 4 bytes
//          4   u16 version = 1
//          6   u16 flags              bit 0: travel moves included
//          8   u32 headerBytes        length of the JSON header, padded with spaces to a multiple of 4
//         12   header JSON (UTF-8)    PreviewHeader
//          …   seg   Float32 × 6n     x0 y0 z0 x1 y1 z1 per segment (mm)
//          …   attr  Uint8   × 4n     feature, tool (0-based filament), width, height (0.01 mm units)
//          …   speed Uint16  × n      mm/s (clamped to 65535), then zero padding to a multiple of 4

/**
 * Feature codes (index = code). Append only, never reorder: old files keep their meaning. The names
 * are Bambu's `; FEATURE:` roles (gcode-preview verifies them against src/libslic3r/ExtrusionEntity.cpp
 * at the pinned tag and appends what is missing). Named so it never clashes with the simulator's
 * FEATURES.
 */
export const PREVIEW_FEATURES = [
	'Other',
	'Travel',
	'Outer wall',
	'Inner wall',
	'Overhang wall',
	'Sparse infill',
	'Internal solid infill',
	'Top surface',
	'Bottom surface',
	'Bridge',
	'Gap infill',
	'Support',
	'Support interface',
	'Support transition',
	'Brim',
	'Skirt',
	'Prime tower',
	'Ironing',
	'Custom',
	'Wipe',
	// Appended by gcode-preview: the rest of ExtrusionEntity::role_to_string (src/libslic3r/
	// ExtrusionEntity.cpp at v02.08.02.61); "Flush" is also what GCodeProcessor calls FLUSH_START blocks.
	'Floating vertical shell',
	'Support ironing',
	'Multiple',
	'Flush'
] as const;
export const TRAVEL_FEATURE = 1;

export interface PreviewLayer {
	z: number;
	height: number;
	seconds: number | null;
	/** Index of the layer's first segment. */
	first: number;
	count: number;
}
export interface PreviewHeader {
	version: 1;
	plate: number;
	source: 'gcode' | 'engine';
	segments: number;
	bbox: [number, number, number, number, number, number];
	/** PREVIEW_FEATURES at write time (lets old decoders show new names). */
	features: string[];
	tools: { index: number; color: string; type: string }[];
	layers: PreviewLayer[];
	totalSeconds: number | null;
	/**
	 * Set when the writer thinned a very large plate to stay interactive: travel moves left out, and how
	 * many extrusion moves shorter than 0.05 mm were joined to their neighbour.
	 */
	decimated?: { travel: boolean; joined: number };
}
export interface PreviewData {
	header: PreviewHeader;
	seg: Float32Array;
	attr: Uint8Array;
	speed: Uint16Array;
}

const MAGIC = [0x50, 0x4c, 0x50, 0x56]; // "PLPV"
const pad4 = (n: number) => (n + 3) & ~3;

export function encodePreview(data: PreviewData): Uint8Array {
	const n = data.header.segments;
	if (!Number.isInteger(n) || n < 0) throw new Error('Preview: bad segment count.');
	if (data.seg.length !== n * 6 || data.attr.length !== n * 4 || data.speed.length !== n)
		throw new Error('Preview: arrays do not match the segment count.');
	const json = new TextEncoder().encode(JSON.stringify(data.header));
	const headerBytes = pad4(json.length);
	const size = 12 + headerBytes + n * 24 + n * 4 + pad4(n * 2);
	const out = new Uint8Array(size);
	const view = new DataView(out.buffer);
	out.set(MAGIC, 0);
	let travel = false;
	for (let i = 0; i < n && !travel; i++) travel = data.attr[i * 4] === TRAVEL_FEATURE;
	view.setUint16(4, 1, true);
	view.setUint16(6, travel ? 1 : 0, true);
	view.setUint32(8, headerBytes, true);
	out.set(json, 12);
	out.fill(0x20, 12 + json.length, 12 + headerBytes);
	let at = 12 + headerBytes;
	for (let i = 0; i < n * 6; i++, at += 4) view.setFloat32(at, data.seg[i], true);
	out.set(data.attr, at);
	at += n * 4;
	for (let i = 0; i < n; i++, at += 2) view.setUint16(at, data.speed[i], true);
	return out;
}

/** Throws on a bad magic, version or sizes (never returns partial data). */
export function decodePreview(bytes: ArrayBuffer | Uint8Array): PreviewData {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	if (u8.length < 12 || MAGIC.some((b, i) => u8[i] !== b)) throw new Error('Not a preview file.');
	const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	const version = view.getUint16(4, true);
	if (version !== 1) throw new Error(`Preview version ${version} is not supported.`);
	const headerBytes = view.getUint32(8, true);
	if (headerBytes % 4 !== 0 || 12 + headerBytes > u8.length)
		throw new Error('Preview: the header does not fit.');
	let header: PreviewHeader;
	try {
		header = JSON.parse(new TextDecoder().decode(u8.subarray(12, 12 + headerBytes)));
	} catch {
		throw new Error('Preview: the header is not valid JSON.');
	}
	const n = header?.segments;
	if (header?.version !== 1 || !Number.isInteger(n) || n < 0)
		throw new Error('Preview: the header is not a preview header.');
	const start = 12 + headerBytes;
	if (u8.length !== start + n * 24 + n * 4 + pad4(n * 2))
		throw new Error('Preview: the data does not match the segment count.');
	const seg = new Float32Array(n * 6);
	for (let i = 0; i < n * 6; i++) seg[i] = view.getFloat32(start + i * 4, true);
	const attr = u8.slice(start + n * 24, start + n * 28);
	const speed = new Uint16Array(n);
	for (let i = 0; i < n; i++) speed[i] = view.getUint16(start + n * 28 + i * 2, true);
	return { header, seg, attr, speed };
}
