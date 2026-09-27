// The objects on a plate of a sliced file, for "Skip objects": Metadata/slice_info.config lists each
// object as <object identify_id name skipped> inside its <plate> (Bambu Studio v02.08.02.61
// src/libslic3r/Format/bbs_3mf.cpp ~8749), Metadata/plate_<n>.json holds the first-layer bounding boxes
// (bbs_3mf.cpp _add_bbox_file_to_archive ~7041, PATTERN_CONFIG_FILE_FORMAT; fields from
// GCode/ThumbnailData.hpp BBoxData/PlateBBoxData: bbox_all, bbox_objects[{ id, name, bbox, area }]) and
// Metadata/plate_<n>.png is the plate picture. skip_objects takes the identify_id values.
// Metadata/top_<n>.png and Metadata/pick_<n>.png (bbs_3mf.cpp ~6560–6620, PICK_FILE_FORMAT) are the
// plate from above and the same view with each object filled in one flat colour that encodes its
// identify_id (see pickId in $lib/shared/controls), which makes a clickable plate map.
// The boxes do not carry identify_id: bbox_objects[].id is the PrintObject's id (Plater.cpp
// generate_first_layer_bbox ~16180 `data.id = obj->id().id`) while identify_id is the ModelInstance's
// id (bbs_3mf.cpp ~8745), and each box covers only an object's first instance (Print.cpp
// get_first_layer_bbox ~1894). So a box is matched by object name, and only when one object on the
// plate has that name.
import { readZip } from '$lib/server/cad/mesh';
import type { PlateObject } from '$lib/shared/controls';

export interface PlateContents {
	objects: PlateObject[];
	bboxAll: [number, number, number, number] | null;
	picture: Buffer | null;
	/** Top view and its pick image, both or neither. */
	top: Buffer | null;
	pick: Buffer | null;
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
	const wanted = new Set([
		'Metadata/slice_info.config',
		`Metadata/plate_${plate}.json`,
		`Metadata/plate_${plate}.png`,
		`Metadata/top_${plate}.png`,
		`Metadata/pick_${plate}.png`
	]);
	const files = readZip(buf, (name) => (wanted.has(name) ? 'all' : false));
	const info = files.get('Metadata/slice_info.config')?.toString('utf8') ?? '';
	let block = '';
	for (const m of info.matchAll(/<plate>([\s\S]*?)<\/plate>/g))
		if (Number(m[1].match(/key="index" value="(\d+)"/)?.[1]) === plate) block = m[1];

	let bboxAll: PlateContents['bboxAll'] = null;
	/** Box by object name; null when two boxes share a name. */
	const boxes = new Map<string, PlateObject['bbox']>();
	const json = files.get(`Metadata/plate_${plate}.json`);
	if (json)
		try {
			const data = JSON.parse(json.toString('utf8'));
			bboxAll = box(data?.bbox_all);
			for (const o of Array.isArray(data?.bbox_objects) ? data.bbox_objects.slice(0, 512) : []) {
				const name = typeof o?.name === 'string' ? o.name : '';
				if (!name) continue;
				boxes.set(name, boxes.has(name) ? null : box(o?.bbox));
			}
		} catch {
			// A damaged bounding-box file only loses the plate map.
		}

	const found: { id: number; name: string; skipped: boolean }[] = [];
	for (const m of block.matchAll(/<object\b[^>]*\/?>/g)) {
		const id = Number(attr(m[0], 'identify_id'));
		if (!Number.isInteger(id) || id < 0) continue;
		const name = unescape(attr(m[0], 'name') ?? '');
		found.push({ id, name, skipped: attr(m[0], 'skipped') === 'true' });
		if (found.length >= 256) break;
	}
	const named = (name: string) => found.filter((o) => o.name === name).length;
	const objects: PlateObject[] = found.map((o) => ({
		id: o.id,
		name: o.name.slice(0, 120) || `Object ${o.id}`,
		skipped: o.skipped,
		bbox: o.name && named(o.name) === 1 ? (boxes.get(o.name) ?? null) : null
	}));
	const top = files.get(`Metadata/top_${plate}.png`) ?? null;
	const pick = files.get(`Metadata/pick_${plate}.png`) ?? null;
	return {
		objects,
		bboxAll,
		picture: files.get(`Metadata/plate_${plate}.png`) ?? null,
		top: top && pick ? top : null,
		pick: top && pick ? pick : null
	};
}
