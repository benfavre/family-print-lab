// Writes the two synthesised fixtures (see README.md). They cover what no project file in the Bambu
// Studio or OrcaSlicer repositories has: painting of all four kinds, every part type, height ranges,
// a layer height profile, two plates with plate settings, dual-nozzle filament maps, custom G-code, text
// parts, and PrusaSlicer-style triangle-range volumes. The XML is written by hand in the layout of
// Bambu Studio's exporter (src/libslic3r/Format/bbs_3mf.cpp, v02.08.02.61) and PrusaSlicer's
// (src/libslic3r/Format/3mf.cpp, version_2.8.1), not by our writer, so the reader is tested against
// independent input. Self-contained (node:zlib only) so it runs with `bunx tsx`:
//   bunx tsx src/lib/server/slicer3mf/__fixtures__/make-synthetic.ts
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const here = import.meta.dirname;

function zip(entries: [string, string | Buffer][]): Buffer {
	const chunks: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const [name, content] of entries) {
		const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
		const raw = zlib.deflateRawSync(data);
		const n = Buffer.from(name, 'utf8');
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(8, 8);
		local.writeUInt32LE(zlib.crc32(data), 14);
		local.writeUInt32LE(raw.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(n.length, 26);
		const dir = Buffer.alloc(46);
		dir.writeUInt32LE(0x02014b50, 0);
		dir.writeUInt16LE(20, 4);
		dir.writeUInt16LE(20, 6);
		dir.writeUInt16LE(8, 10);
		dir.writeUInt32LE(zlib.crc32(data), 16);
		dir.writeUInt32LE(raw.length, 20);
		dir.writeUInt32LE(data.length, 24);
		dir.writeUInt16LE(n.length, 28);
		dir.writeUInt32LE(offset, 42);
		chunks.push(local, n, raw);
		central.push(dir, n);
		offset += 30 + n.length + raw.length;
	}
	const cd = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(cd.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...chunks, cd, end]);
}

// A 1×1×1 cube and a tetrahedron, as upstream writes them.
const CUBE_V = [
	[0, 0, 0],
	[1, 0, 0],
	[1, 1, 0],
	[0, 1, 0],
	[0, 0, 1],
	[1, 0, 1],
	[1, 1, 1],
	[0, 1, 1]
];
const CUBE_T = [
	[0, 2, 1],
	[0, 3, 2],
	[4, 5, 6],
	[4, 6, 7],
	[0, 1, 5],
	[0, 5, 4],
	[1, 2, 6],
	[1, 6, 5],
	[2, 3, 7],
	[2, 7, 6],
	[3, 0, 4],
	[3, 4, 7]
];
const TETRA_V = [
	[0, 0, 0],
	[10, 0, 0],
	[0, 10, 0],
	[0, 0, 10]
];
const TETRA_T = [
	[0, 2, 1],
	[0, 1, 3],
	[1, 2, 3],
	[0, 3, 2]
];

const vertices = (v: number[][]) =>
	v.map(([x, y, z]) => `     <vertex x="${x}" y="${y}" z="${z}"/>\n`).join('');
const triangles = (t: number[][], attrs: Record<number, string> = {}) =>
	t
		.map(
			([a, b, c], i) => `     <triangle v1="${a}" v2="${b}" v3="${c}"${attrs[i] ? ' ' + attrs[i] : ''}/>\n`
		)
		.join('');
const mesh = (id: number, uuid: string, type: string, v: number[][], t: number[][], attrs = {}) =>
	`  <object id="${id}" p:UUID="${uuid}-81cb-4c03-9d28-80fed5dfa1dc" type="${type}">\n   <mesh>\n    <vertices>\n${vertices(v)}    </vertices>\n    <triangles>\n${triangles(t, attrs)}    </triangles>\n   </mesh>\n  </object>\n`;
const HEAD = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">\n`;
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n <Default Extension="png" ContentType="image/png"/>\n <Default Extension="gcode" ContentType="text/x.gcode"/>\n</Types>`;
// A 1×1 transparent PNG.
const PNG = Buffer.from(
	'89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6300010000050001' +
		'0d0a2db40000000049454e44ae426082',
	'hex'
);

// Painting strings (TriangleSelector serialisation, see shared/slicer/paint.ts): "4" enforcer/filament 1,
// "8" blocker/filament 2, "0C" filament 3, "1C" filament 4, "481" = split in two (filament 1 | 2).
function bambu() {
	const painted = mesh(1, '00000000', 'model', CUBE_V, CUBE_T, {
		0: 'paint_supports="4"',
		1: 'paint_supports="8" paint_seam="4"',
		2: 'paint_fuzzy_skin="4" paint_color="0C"',
		3: 'paint_color="481"',
		4: 'paint_color="1C"'
	});
	const objectFile1 =
		HEAD +
		' <metadata name="BambuStudio:3mfVersion">1</metadata>\n <resources>\n' +
		painted +
		mesh(2, '00000001', 'other', CUBE_V, CUBE_T) +
		mesh(3, '00000002', 'other', TETRA_V, TETRA_T) +
		mesh(4, '00000003', 'other', CUBE_V.map(([x, y, z]) => [x * 2, y * 2, z]), CUBE_T) +
		mesh(5, '00000004', 'other', CUBE_V.map(([x, y, z]) => [x, y, z * 3]), CUBE_T) +
		mesh(6, '00000005', 'model', TETRA_V.map(([x, y, z]) => [x + 20, y, z / 2]), TETRA_T) +
		' </resources>\n <build/>\n</model>\n';
	const objectFile2 =
		HEAD +
		' <metadata name="BambuStudio:3mfVersion">1</metadata>\n <resources>\n' +
		mesh(8, '00010000', 'model', TETRA_V, TETRA_T) +
		' </resources>\n <build/>\n</model>\n';
	const comp = (sub: number, n: number, transform: string, file = 'object_1') =>
		`    <component p:path="/3D/Objects/${file}.model" objectid="${sub}" p:UUID="${n.toString(16).padStart(8, '0')}-b206-40ff-9872-83e8017abed1" transform="${transform}"/>\n`;
	const root =
		HEAD +
		[
			['Application', 'BambuStudio-02.08.02.61'],
			['BambuStudio:3mfVersion', '1'],
			['Copyright', ''],
			['CreationDate', '2026-09-01'],
			['Description', 'Synthesised fixture &amp;amp; test'],
			['Designer', 'Family Print Lab'],
			['DesignerCover', ''],
			['DesignerUserId', ''],
			['License', 'CC-BY-4.0'],
			['ModificationDate', '2026-09-02'],
			['Origin', 'Family Print Lab tests'],
			['Title', 'Every feature']
		]
			.map(([k, v]) => ` <metadata name="${k}">${v}</metadata>\n`)
			.join('') +
		' <resources>\n' +
		'  <object id="9" p:UUID="00000001-61cb-4c03-9d28-80fed5dfa1dc" type="model">\n   <components>\n' +
		comp(1, 0x10000, '10 0 0 0 10 0 0 0 10 0 0 0') +
		comp(2, 0x10001, '4 0 0 0 4 0 0 0 2 3 3 0') +
		comp(3, 0x10002, '0.2 0 0 0 0.2 0 0 0 0.2 1 1 8') +
		comp(4, 0x10003, '1 0 0 0 1 0 0 0 1 -5 -5 0') +
		comp(5, 0x10004, '1 0 0 0 1 0 0 0 1 12 12 0') +
		comp(6, 0x10005, '0.25 0 0 0 0.25 0 0 0 0.25 0 0 10') +
		'   </components>\n  </object>\n' +
		'  <object id="10" p:UUID="00000002-61cb-4c03-9d28-80fed5dfa1dc" type="model">\n   <components>\n' +
		comp(8, 0x20000, '0.70710678118654757 0.70710678118654746 0 -0.70710678118654746 0.70710678118654757 0 0 0 1 0 0 0', 'object_2') +
		'   </components>\n  </object>\n' +
		' </resources>\n' +
		' <build p:UUID="2c7c17d8-22b5-4d84-8835-1976022ea369">\n' +
		'  <item objectid="9" p:UUID="00000001-b1ec-4553-aec9-835e5b724bb4" transform="1 0 0 0 1 0 0 0 1 100 100 0" printable="1"/>\n' +
		'  <item objectid="9" p:UUID="00000002-b1ec-4553-aec9-835e5b724bb4" transform="-1 0 0 0 -1 0 0 0 1 150 100 0" printable="0"/>\n' +
		'  <item objectid="10" p:UUID="00000003-b1ec-4553-aec9-835e5b724bb4" transform="1 0 0 0 1 0 0 0 1 128.5 128.25 -0" printable="1"/>\n' +
		' </build>\n</model>\n';
	const meta = (i: string, k: string, v: string) => `${i}<metadata key="${k}" value="${v}"/>\n`;
	const part = (id: number, subtype: string, name: string, extra = '') =>
		`    <part id="${id}" subtype="${subtype}">\n${meta('      ', 'name', name)}${meta('      ', 'matrix', '1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1')}${extra}      <mesh_stat face_count="12" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>\n    </part>\n`;
	const modelSettings =
		'<?xml version="1.0" encoding="UTF-8"?>\n<config>\n' +
		'  <object id="9">\n' +
		meta('    ', 'name', 'Painted cube') +
		meta('    ', 'extruder', '1') +
		meta('    ', 'wall_loops', '3') +
		'    <metadata face_count="64"/>\n' +
		part(
			1,
			'normal_part',
			'Cube',
			meta('      ', 'source_file', 'cube.stl') +
				meta('      ', 'source_object_id', '0') +
				meta('      ', 'source_volume_id', '0') +
				meta('      ', 'source_offset_x', '0.5') +
				meta('      ', 'source_offset_y', '0.5') +
				meta('      ', 'source_offset_z', '0.5')
		) +
		part(
			2,
			'modifier_part',
			'Generic-Cube',
			meta('      ', 'extruder', '2') + meta('      ', 'sparse_infill_density', '40%')
		) +
		part(3, 'negative_part', 'Hole') +
		part(4, 'support_blocker', 'Blocker') +
		part(5, 'support_enforcer', 'Enforcer') +
		`    <part id="6" subtype="normal_part" uuid="7b0f0a44-4c0b-4bde-9b41-2f3a1d6a9e11">\n${meta('      ', 'name', 'Label')}      <text_info text="Hi &amp; bye" font_name="HarmonyOS Sans SC" font_version="2.0" style_name="Regular" font_index="0" font_size="16" thickness="2" embeded_depth="0" rotate_angle="0" text_gap="0" bold="0" italic="0" surface_text="1" keep_horizontal="0" hit_mesh="0" hit_position="0 0 0" hit_normal="0 0 1"/>\n      <mesh_stat face_count="4" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>\n    </part>\n` +
		'  </object>\n' +
		'  <object id="10">\n' +
		meta('    ', 'name', 'Spinning tetra') +
		meta('    ', 'module', 'calibration') +
		meta('    ', 'extruder', '3') +
		'    <metadata face_count="4"/>\n' +
		part(8, 'normal_part', 'Tetra') +
		'  </object>\n' +
		'  <plate>\n' +
		meta('    ', 'plater_id', '1') +
		meta('    ', 'plater_name', 'Main') +
		meta('    ', 'locked', 'false') +
		meta('    ', 'bed_type', 'Textured PEI Plate') +
		meta('    ', 'print_sequence', 'by object') +
		meta('    ', 'first_layer_print_sequence', '2 1 3') +
		meta('    ', 'other_layers_print_sequence', '1 2') +
		meta('    ', 'other_layers_print_sequence_nums', '1') +
		meta('    ', 'spiral_mode', 'false') +
		meta('    ', 'filament_map_mode', 'Manual') +
		meta('    ', 'filament_maps', '1 2 1') +
		meta('    ', 'thumbnail_file', 'Metadata/plate_1.png') +
		meta('    ', 'pattern_bbox_file', 'Metadata/plate_1.json') +
		'    <model_instance>\n' +
		meta('      ', 'object_id', '9') +
		meta('      ', 'instance_id', '0') +
		meta('      ', 'identify_id', '101') +
		'    </model_instance>\n' +
		'    <model_instance>\n' +
		meta('      ', 'object_id', '9') +
		meta('      ', 'instance_id', '1') +
		meta('      ', 'identify_id', '102') +
		'    </model_instance>\n' +
		'  </plate>\n' +
		'  <plate>\n' +
		meta('    ', 'plater_id', '2') +
		meta('    ', 'plater_name', 'Second &amp;amp; last') +
		meta('    ', 'locked', 'true') +
		meta('    ', 'bed_type', 'Cool Plate') +
		meta('    ', 'spiral_mode', 'true') +
		'    <model_instance>\n' +
		meta('      ', 'object_id', '10') +
		meta('      ', 'instance_id', '0') +
		meta('      ', 'identify_id', '103') +
		'    </model_instance>\n' +
		'  </plate>\n' +
		'  <assemble>\n   <assemble_item object_id="9" instance_id="0" transform="1 0 0 0 1 0 0 0 1 100 100 0" offset="0 0 0" />\n  </assemble>\n' +
		'</config>\n';
	const projectSettings =
		JSON.stringify(
			{
				filament_colour: ['#FFFFFF', '#FF0000', '#00AE42'],
				filament_settings_id: [
					'Bambu PLA Basic @BBL H2D',
					'Bambu PLA Basic @BBL H2D',
					'Bambu PETG HF @BBL H2D'
				],
				filament_type: ['PLA', 'PLA', 'PETG'],
				layer_height: '0.2',
				nozzle_diameter: ['0.4', '0.4'],
				print_settings_id: '0.20mm Standard @BBL H2D',
				printer_model: 'Bambu Lab H2D',
				printer_settings_id: 'Bambu Lab H2D 0.4 nozzle',
				wall_loops: '2'
			},
			null,
			4
		) + '\n';
	return zip([
		['[Content_Types].xml', CONTENT_TYPES],
		[
			'_rels/.rels',
			'<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n <Relationship Target="/Metadata/plate_1.png" Id="rel-2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>\n</Relationships>'
		],
		['3D/3dmodel.model', root],
		[
			'3D/_rels/3dmodel.model.rels',
			'<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n <Relationship Target="/3D/Objects/object_1.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n <Relationship Target="/3D/Objects/object_2.model" Id="rel-2" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>'
		],
		['3D/Objects/object_1.model', objectFile1],
		['3D/Objects/object_2.model', objectFile2],
		['Metadata/plate_1.png', PNG],
		['Metadata/plate_1.json', '{"bbox_objects":[]}'],
		['Metadata/model_settings.config', modelSettings],
		['Metadata/project_settings.config', projectSettings],
		[
			'Metadata/layer_heights_profile.txt',
			'object_id=1|0.000000;0.200000;4.000000;0.120000;10.000000;0.280000\n'
		],
		[
			'Metadata/layer_config_ranges.xml',
			'<?xml version="1.0" encoding="utf-8"?>\n<objects>\n <object id="1">\n  <range min_z="0" max_z="2.5">\n   <option opt_key="layer_height">0.12</option>\n   <option opt_key="extruder">2</option>\n  </range>\n  <range min_z="2.5" max_z="6">\n   <option opt_key="sparse_infill_density">&lt;25%&gt;</option>\n  </range>\n </object>\n</objects>\n'
		],
		[
			'Metadata/custom_gcode_per_layer.xml',
			'<?xml version="1.0" encoding="utf-8"?>\n<custom_gcodes_per_layer>\n<plate>\n<plate_info id="2"/>\n<layer top_z="3.2" type="1" extruder="1" color="" extra="Swap to red" gcode="M400 U1"/>\n<layer top_z="5.2" type="0" extruder="2" color="#FF0000" extra="" gcode="M600"/>\n<mode value="MultiAsSingle"/>\n</plate>\n</custom_gcodes_per_layer>\n'
		],
		[
			'Metadata/cut_information.xml',
			'<?xml version="1.0" encoding="utf-8"?>\n<objects>\n <object id="1">\n  <cut_id id="12" check_sum="1" connectors_cnt="0"/>\n </object>\n <object id="2">\n  <cut_id id="0" check_sum="1" connectors_cnt="0"/>\n </object>\n</objects>\n'
		],
		[
			'Metadata/filament_sequence.json',
			'{"plate_1":{"nozzle_sequence":[0,1],"optimal_assignment":[1,0],"sequence":[1,2,1]}}'
		],
		[
			'Metadata/slice_info.config',
			'<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header>\n    <header_item key="X-BBL-Client-Type" value="slicer"/>\n    <header_item key="X-BBL-Client-Version" value="02.08.02.61"/>\n  </header>\n</config>\n'
		],
		['Auxiliaries/Model Pictures/Größe.txt', 'Non-ASCII passthrough name.\n']
	]);
}

function prusa() {
	// One mesh, two volumes as triangle ranges; painting uses PrusaSlicer's attribute names.
	const v = [...CUBE_V.map(([x, y, z]) => [x * 20, y * 20, z * 20]), ...TETRA_V.map(([x, y, z]) => [x + 5, y + 5, z + 5])];
	const t = [...CUBE_T, ...TETRA_T.map((tri) => tri.map((i) => i + 8))];
	const model = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">\n <metadata name="slic3rpe:Version3mf">1</metadata>\n <metadata name="Title">Prusa pair</metadata>\n <metadata name="Application">PrusaSlicer-2.8.1</metadata>\n <resources>\n  <object id="1" type="model">\n   <mesh>\n    <vertices>\n${vertices(v)}    </vertices>\n    <triangles>\n${triangles(t, { 0: 'slic3rpe:custom_supports="4"', 13: 'slic3rpe:mmu_segmentation="8"', 14: 'slic3rpe:custom_seam="4"' })}    </triangles>\n   </mesh>\n  </object>\n </resources>\n <build>\n  <item objectid="1" transform="1 0 0 0 1 0 0 0 1 125 105 0" printable="1"/>\n </build>\n</model>\n`;
	const config = `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n <object id="1" instances_count="1">\n  <metadata type="object" key="name" value="Prusa pair"/>\n  <metadata type="object" key="layer_height" value="0.15"/>\n  <volume firstid="0" lastid="11">\n   <metadata type="volume" key="name" value="Body"/>\n   <metadata type="volume" key="volume_type" value="ModelPart"/>\n   <metadata type="volume" key="matrix" value="1 0 0 10 0 1 0 10 0 0 1 10 0 0 0 1"/>\n   <metadata type="volume" key="extruder" value="1"/>\n   <mesh edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>\n  </volume>\n  <volume firstid="12" lastid="15">\n   <metadata type="volume" key="name" value="Denser"/>\n   <metadata type="volume" key="volume_type" value="ParameterModifier"/>\n   <metadata type="volume" key="fill_density" value="50%"/>\n   <mesh edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>\n  </volume>\n </object>\n</config>\n`;
	return zip([
		[
			'[Content_Types].xml',
			'<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="png" ContentType="image/png"/></Types>'
		],
		[
			'_rels/.rels',
			'<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'
		],
		['3D/3dmodel.model', model],
		['Metadata/Slic3r_PE_model.config', config],
		['Metadata/Slic3r_PE.config', '; generated by PrusaSlicer 2.8.1\n; layer_height = 0.15\n'],
		['Metadata/Slic3r_PE_layer_heights_profile.txt', 'object_id=1|0;0.15;10;0.1;20;0.2\n']
	]);
}

fs.writeFileSync(path.join(here, 'synth-bambu-features.3mf'), bambu());
fs.writeFileSync(path.join(here, 'synth-prusa-volumes.3mf'), prusa());
console.log('Wrote synth-bambu-features.3mf and synth-prusa-volumes.3mf');
