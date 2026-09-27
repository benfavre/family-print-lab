// Test fixtures: sliced files with objects on the plate, the way Bambu Studio writes them.
import { fakeSliced } from '$lib/server/printer/sliced';
import { readZip, writeZip } from '$lib/server/cad/mesh';

/**
 * fakeSliced plus what Bambu Studio adds for skip objects: <object> entries in slice_info.config
 * (bbs_3mf.cpp ~8749; names XML-escaped) and Metadata/plate_1.json with bbox_objects
 * (ThumbnailData.hpp PlateBBoxData; Plater.cpp generate_first_layer_bbox).
 */
export function slicedWithObjects(
	objects: { id: number; name: string; skipped?: boolean; bbox?: number[] }[],
	o: { json?: string | null; picture?: Buffer; top?: Buffer; pick?: Buffer; model?: string } = {}
): Buffer {
	const files = readZip(
		fakeSliced({ minutes: 30, grams: 12, printerModelId: o.model ?? 'N6' }),
		() => 'all'
	);
	const info = files
		.get('Metadata/slice_info.config')!
		.toString('utf8')
		.replace(
			'  </plate>',
			`${objects.map((x) => `    <object identify_id="${x.id}" name="${x.name}" skipped="${x.skipped ? 'true' : 'false'}" />`).join('\n')}\n  </plate>`
		);
	files.set('Metadata/slice_info.config', Buffer.from(info));
	const json =
		o.json !== undefined
			? o.json
			: JSON.stringify({
					bbox_all: [10, 10, 200, 150],
					// One box per PrintObject: its own id (not identify_id) and the object's name.
					bbox_objects: objects.map((x, i) => ({
						id: 9000 + i,
						name: x.name.replace(/&amp;/g, '&'),
						bbox: x.bbox ?? [10, 10, 50, 50],
						area: 100,
						layer_height: 0.2
					})),
					filament_ids: [0],
					is_seq_print: false,
					version: 2
				});
	if (json !== null) files.set('Metadata/plate_1.json', Buffer.from(json));
	if (o.picture) files.set('Metadata/plate_1.png', o.picture);
	if (o.top) files.set('Metadata/top_1.png', o.top);
	if (o.pick) files.set('Metadata/pick_1.png', o.pick);
	return writeZip([...files]);
}
