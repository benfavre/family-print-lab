// The objects on a plate of a sliced file, for "Skip objects": Metadata/slice_info.config lists each
// object as <object identify_id name skipped> inside its <plate> (Bambu Studio v02.08.02.61
// src/libslic3r/Format/bbs_3mf.cpp ~8749), Metadata/plate_<n>.json holds the first-layer bounding boxes
// (bbs_3mf.cpp _add_bbox_file_to_archive ~7041, PATTERN_CONFIG_FILE_FORMAT; fields from
// GCode/ThumbnailData.hpp BBoxData/PlateBBoxData: bbox_all, bbox_objects[{ id, name, bbox, area }]) and
// Metadata/plate_<n>.png is the plate picture. skip_objects takes the identify_id values.
import { readZip } from '$lib/server/cad/mesh';
import type { PlateObject } from '$lib/shared/controls';

export interface PlateContents {
	objects: PlateObject[];
	bboxAll: [number, number, number, number] | null;
	picture: Buffer | null;
}

const attr = (tag: string, name: string) => {
	const v = tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
	return v === undefined ? null : v;
};
const unescape = (s: string) =>
	s
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&');

function box(v: unknown): [number, number, number, number] | null {
	if (!Array.isArray(v) || v.length !== 4) return null;
	const n = v.map(Number);
	return n.every(Number.isFinite) ? (n as [number, number, number, number]) : null;
}

/** Reads the objects of plate `plate` (1-based) from a sliced .gcode.3mf. */
export function readPlateObjects(buf: Buffer, plate: number): PlateContents {
	const files = readZip(buf, (name) =>
		name === 'Metadata/slice_info.config' ||
		name === `Metadata/plate_${plate}.json` ||
		name === `Metadata/plate_${plate}.png`
			? 'all'
			: false
	);
	const info = files.get('Metadata/slice_info.config')?.toString('utf8') ?? '';
	let block = '';
	for (const m of info.matchAll(/<plate>([\s\S]*?)<\/plate>/g))
		if (Number(m[1].match(/key="index" value="(\d+)"/)?.[1]) === plate) block = m[1];

	let bboxAll: PlateContents['bboxAll'] = null;
	const boxes = new Map<number, { name: string; bbox: PlateObject['bbox'] }>();
	const json = files.get(`Metadata/plate_${plate}.json`);
	if (json)
		try {
			const data = JSON.parse(json.toString('utf8'));
			bboxAll = box(data?.bbox_all);
			for (const o of Array.isArray(data?.bbox_objects) ? data.bbox_objects.slice(0, 512) : []) {
				const id = Number(o?.id);
				if (Number.isInteger(id))
					boxes.set(id, { name: String(o?.name ?? ''), bbox: box(o?.bbox) });
			}
		} catch {
			// A damaged bounding-box file only loses the plate map.
		}

	const objects: PlateObject[] = [];
	for (const m of block.matchAll(/<object\b[^>]*\/?>/g)) {
		const id = Number(attr(m[0], 'identify_id'));
		if (!Number.isInteger(id) || id < 0) continue;
		const name = unescape(attr(m[0], 'name') ?? '').slice(0, 120);
		// Boxes carry the same id when Bambu Studio wrote both; otherwise match by name (unverified which
		// id bbox_objects uses on every version, so both are tried).
		const found =
			boxes.get(id) ?? [...boxes.values()].find((b) => b.name && b.name === name) ?? null;
		objects.push({
			id,
			name: name || `Object ${id}`,
			skipped: attr(m[0], 'skipped') === 'true',
			bbox: found?.bbox ?? null
		});
		if (objects.length >= 256) break;
	}
	return { objects, bboxAll, picture: files.get(`Metadata/plate_${plate}.png`) ?? null };
}
