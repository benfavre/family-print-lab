// Mesh I/O and geometry: STL/OBJ/3MF import, STL/3MF export, stats, and robust edits via Manifold.
// Meshes travel as triangle soups (Float32Array of xyz per vertex, 9 floats per triangle).
import zlib from 'node:zlib';
import { AppError } from '../validation';

import type { MeshStats } from '$lib/shared/cad';
export type { MeshStats };
export type Soup = Float32Array;

// ---------- STL ----------

export function parseStl(buf: Buffer): Soup {
	const head = buf.subarray(0, Math.min(buf.length, 512)).toString('latin1');
	const binaryCount = buf.length >= 84 ? buf.readUInt32LE(80) : -1;
	if (binaryCount >= 0 && 84 + binaryCount * 50 === buf.length) {
		const out = new Float32Array(binaryCount * 9);
		for (let i = 0; i < binaryCount; i++) {
			const o = 84 + i * 50 + 12; // skip the normal
			for (let k = 0; k < 9; k++) out[i * 9 + k] = buf.readFloatLE(o + k * 4);
		}
		return out;
	}
	if (/^\s*solid/.test(head)) {
		const values: number[] = [];
		const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
		const text = buf.toString('latin1');
		let m: RegExpExecArray | null;
		while ((m = re.exec(text))) values.push(Number(m[1]), Number(m[2]), Number(m[3]));
		if (values.length && values.length % 9 === 0 && values.every(Number.isFinite))
			return Float32Array.from(values);
	}
	throw new AppError(400, 'That file is not a valid STL.');
}

export function writeStl(soup: Soup, header = 'Family Print Lab'): Buffer {
	const n = soup.length / 9;
	const buf = Buffer.alloc(84 + n * 50);
	buf.write(header.slice(0, 79), 0, 'latin1');
	buf.writeUInt32LE(n, 80);
	for (let i = 0; i < n; i++) {
		const o = 84 + i * 50,
			t = i * 9;
		const [ax, ay, az, bx, by, bz, cx, cy, cz] = soup.subarray(t, t + 9);
		const ux = bx - ax,
			uy = by - ay,
			uz = bz - az,
			vx = cx - ax,
			vy = cy - ay,
			vz = cz - az;
		let nx = uy * vz - uz * vy,
			ny = uz * vx - ux * vz,
			nz = ux * vy - uy * vx;
		const len = Math.hypot(nx, ny, nz) || 1;
		nx /= len;
		ny /= len;
		nz /= len;
		[nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz].forEach((v, k) =>
			buf.writeFloatLE(v, o + k * 4)
		);
	}
	return buf;
}

// ---------- OBJ ----------

export function parseObj(text: string): Soup {
	const verts: number[][] = [];
	const out: number[] = [];
	for (const line of text.split(/\r?\n/)) {
		const parts = line.trim().split(/\s+/);
		if (parts[0] === 'v') verts.push(parts.slice(1, 4).map(Number));
		else if (parts[0] === 'f') {
			const idx = parts.slice(1).map((p) => {
				const i = parseInt(p.split('/')[0], 10);
				return i < 0 ? verts.length + i : i - 1;
			});
			for (let k = 1; k + 1 < idx.length; k++)
				for (const i of [idx[0], idx[k], idx[k + 1]]) out.push(...(verts[i] ?? [NaN, NaN, NaN]));
		}
	}
	if (!out.length || !out.every(Number.isFinite))
		throw new AppError(400, 'That file is not a valid OBJ mesh.');
	return Float32Array.from(out);
}

// ---------- ZIP (for 3MF) ----------

interface ZipEntry {
	name: string;
	method: number;
	crc: number;
	size: number;
	/** The entry's stored (usually deflated) bytes. */
	raw: Buffer;
}

const MAX_ENTRIES = 10_000;

/** Lists a zip's entries without unpacking them; friendly errors for broken or unsupported files. */
function zipEntries(buf: Buffer): ZipEntry[] {
	const bad = (why = 'That file is not a valid 3MF (zip) archive.') => new AppError(400, why);
	let eocd = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--)
		if (buf.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	if (eocd < 0) throw bad();
	const count = buf.readUInt16LE(eocd + 10);
	let p = buf.readUInt32LE(eocd + 16);
	if (count === 0xffff || p === 0xffffffff)
		throw bad('That archive uses the ZIP64 format, which is not supported here.');
	if (count > MAX_ENTRIES) throw bad('That archive has too many files in it.');
	const entries: ZipEntry[] = [];
	for (let i = 0; i < count; i++) {
		if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50)
			throw bad('Corrupt 3MF archive.');
		const method = buf.readUInt16LE(p + 10),
			crc = buf.readUInt32LE(p + 16),
			packed = buf.readUInt32LE(p + 20),
			size = buf.readUInt32LE(p + 24),
			nameLen = buf.readUInt16LE(p + 28),
			extraLen = buf.readUInt16LE(p + 30),
			commentLen = buf.readUInt16LE(p + 32),
			local = buf.readUInt32LE(p + 42);
		if (packed === 0xffffffff || size === 0xffffffff || local === 0xffffffff)
			throw bad('That archive uses the ZIP64 format, which is not supported here.');
		const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
		if (local + 30 > buf.length) throw bad('Corrupt 3MF archive.');
		const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
		if (dataStart + packed > buf.length) throw bad('Corrupt 3MF archive.');
		entries.push({ name, method, crc, size, raw: buf.subarray(dataStart, dataStart + packed) });
		p += 46 + nameLen + extraLen + commentLen;
	}
	return entries;
}

/**
 * Reads the entries of a zip whose names match `want` (3MF meshes by default). `head` entries are only
 * partly inflated (their first bytes), for peeking at large files such as G-code.
 */
export function readZip(
	buf: Buffer,
	want: (name: string) => 'all' | 'head' | false = (n) => (/\.model$/i.test(n) ? 'all' : false)
): Map<string, Buffer> {
	const files = new Map<string, Buffer>();
	for (const e of zipEntries(buf)) {
		const mode = want(e.name);
		if (!mode || (e.method !== 0 && e.method !== 8)) continue;
		if (mode === 'head')
			files.set(
				e.name,
				e.method === 0
					? e.raw.subarray(0, 16_384)
					: zlib.inflateRawSync(e.raw.subarray(0, 16_384), {
							finishFlush: zlib.constants.Z_SYNC_FLUSH,
							maxOutputLength: 1 << 20
						})
			);
		else
			files.set(
				e.name,
				e.method === 0 ? e.raw : zlib.inflateRawSync(e.raw, { maxOutputLength: 512 * 1024 * 1024 })
			);
	}
	return files;
}

/** Deflated zip, enough for a 3MF container. */
export function writeZip(entries: [string, Buffer][]): Buffer {
	return packZip(
		entries.map(([name, data]) => ({
			name,
			method: 8,
			crc: zlib.crc32(data),
			size: data.length,
			raw: zlib.deflateRawSync(data)
		}))
	);
}

/**
 * Rewrites a zip with some entries replaced or added, copying every other entry's compressed bytes
 * as they are (no re-compressing large G-code).
 */
export function rewriteZip(buf: Buffer, changes: Map<string, Buffer>): Buffer {
	const kept = zipEntries(buf).filter((e) => !changes.has(e.name));
	const added = [...changes].map(([name, data]) => ({
		name,
		method: 8,
		crc: zlib.crc32(data),
		size: data.length,
		raw: zlib.deflateRawSync(data)
	}));
	return packZip([...kept, ...added]);
}

function packZip(entries: ZipEntry[]): Buffer {
	const chunks: Buffer[] = [],
		central: Buffer[] = [];
	let offset = 0;
	for (const e of entries) {
		const nameBuf = Buffer.from(e.name, 'utf8');
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(e.method, 8);
		local.writeUInt32LE(e.crc, 14);
		local.writeUInt32LE(e.raw.length, 18);
		local.writeUInt32LE(e.size, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		const dir = Buffer.alloc(46);
		dir.writeUInt32LE(0x02014b50, 0);
		dir.writeUInt16LE(20, 4);
		dir.writeUInt16LE(20, 6);
		dir.writeUInt16LE(e.method, 10);
		dir.writeUInt32LE(e.crc, 16);
		dir.writeUInt32LE(e.raw.length, 20);
		dir.writeUInt32LE(e.size, 24);
		dir.writeUInt16LE(nameBuf.length, 28);
		dir.writeUInt32LE(offset, 42);
		chunks.push(local, nameBuf, e.raw);
		central.push(dir, nameBuf);
		offset += 30 + nameBuf.length + e.raw.length;
	}
	const dirBuf = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(dirBuf.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...chunks, dirBuf, end]);
}

// ---------- 3MF ----------

/** Reads every mesh object in a 3MF (core spec). Component transforms are not applied. */
export function parse3mf(buf: Buffer): Soup {
	const out: number[] = [];
	for (const xml of readZip(buf).values()) {
		const text = xml.toString('utf8');
		for (const mesh of text.match(/<mesh[\s>][\s\S]*?<\/mesh>/g) ?? []) {
			const verts = [
				...mesh.matchAll(/<vertex\s[^>]*?x="([^"]+)"[^>]*?y="([^"]+)"[^>]*?z="([^"]+)"/g)
			].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
			for (const t of mesh.matchAll(/<triangle\s[^>]*?v1="(\d+)"[^>]*?v2="(\d+)"[^>]*?v3="(\d+)"/g))
				for (const i of [t[1], t[2], t[3]]) out.push(...(verts[Number(i)] ?? [NaN, NaN, NaN]));
		}
	}
	if (!out.length || !out.every(Number.isFinite))
		throw new AppError(400, 'No readable mesh in that 3MF file.');
	return Float32Array.from(out);
}

/** Merges identical vertices; returns indexed geometry. */
export function indexed(soup: Soup) {
	const map = new Map<string, number>(),
		verts: number[] = [],
		tris = new Uint32Array(soup.length / 3);
	for (let i = 0; i < soup.length; i += 3) {
		const key = `${soup[i]},${soup[i + 1]},${soup[i + 2]}`;
		let id = map.get(key);
		if (id === undefined) {
			id = verts.length / 3;
			map.set(key, id);
			verts.push(soup[i], soup[i + 1], soup[i + 2]);
		}
		tris[i / 3] = id;
	}
	return { vertices: Float32Array.from(verts), triangles: tris };
}

export function write3mf(soup: Soup, name = 'Part'): Buffer {
	const { vertices, triangles } = indexed(soup);
	const v: string[] = [],
		t: string[] = [];
	for (let i = 0; i < vertices.length; i += 3)
		v.push(`<vertex x="${vertices[i]}" y="${vertices[i + 1]}" z="${vertices[i + 2]}"/>`);
	for (let i = 0; i < triangles.length; i += 3)
		t.push(`<triangle v1="${triangles[i]}" v2="${triangles[i + 1]}" v3="${triangles[i + 2]}"/>`);
	const safe = name.replace(/[<>&"]/g, '');
	const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Application">Family Print Lab</metadata>
<resources><object id="1" type="model" name="${safe}"><mesh><vertices>${v.join('')}</vertices><triangles>${t.join('')}</triangles></mesh></object></resources>
<build><item objectid="1"/></build>
</model>`;
	return writeZip([
		[
			'[Content_Types].xml',
			Buffer.from(
				'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'
			)
		],
		[
			'_rels/.rels',
			Buffer.from(
				'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'
			)
		],
		['3D/3dmodel.model', Buffer.from(model)]
	]);
}

// ---------- Import dispatch and stats ----------

export const MESH_FORMATS = ['stl', '3mf', 'obj'] as const;
export type MeshFormat = (typeof MESH_FORMATS)[number];

export function importMesh(buf: Buffer, format: MeshFormat): Soup {
	const soup =
		format === 'stl'
			? parseStl(buf)
			: format === '3mf'
				? parse3mf(buf)
				: parseObj(buf.toString('utf8'));
	if (soup.length / 9 > 5_000_000)
		throw new AppError(413, 'That model has more than 5 million triangles.');
	return soup;
}

export function stats(soup: Soup): MeshStats {
	const min = [Infinity, Infinity, Infinity],
		max = [-Infinity, -Infinity, -Infinity];
	let volume = 0;
	for (let i = 0; i < soup.length; i += 9) {
		for (let k = 0; k < 9; k++) {
			const axis = k % 3;
			if (soup[i + k] < min[axis]) min[axis] = soup[i + k];
			if (soup[i + k] > max[axis]) max[axis] = soup[i + k];
		}
		const [ax, ay, az, bx, by, bz, cx, cy, cz] = soup.subarray(i, i + 9);
		volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
	}
	const empty = soup.length === 0;
	return {
		triangles: soup.length / 9,
		min: empty ? [0, 0, 0] : (min as [number, number, number]),
		size: empty ? [0, 0, 0] : (max.map((v, i) => v - min[i]) as [number, number, number]),
		volume: Math.abs(volume)
	};
}
