// Writes a Project as a Bambu Studio project 3MF, laid out the way upstream's exporter does
// (src/libslic3r/Format/bbs_3mf.cpp, _BBS_3MF_Exporter, v02.08.02.61): a root 3D/3dmodel.model whose
// objects are components pointing at meshes in 3D/Objects/*.model (production extension p:path),
// Metadata/model_settings.config for names, parts, settings and plates, Metadata/project_settings.config
// for the settings, and the per-object side files. Passthrough files are copied byte for byte.
//
// origin: BambuStudio src/libslic3r/Format/bbs_3mf.cpp @ 926a7192574bcb9b3a732e1ec59a46d79cb45466
import fs from 'node:fs';
import { writeZip } from '../cad/mesh';
import { AppError } from '../validation';
import { escapeXml } from './xml';
import { formatG9, formatNumber, type MeshGeometry } from './mesh';
import { formatTransform } from './transform';
import {
	CONTENT_TYPES_FILE,
	CUSTOM_GCODE_PER_PRINT_Z_FILE,
	CUT_INFORMATION_FILE,
	FACE_PROPERTY_ATTR,
	FILAMENT_SEQUENCE_FILE,
	INSTANCE_KEYS,
	LAYER_CONFIG_RANGES_FILE,
	LAYER_HEIGHTS_PROFILE_FILE,
	META,
	META_3MF_VERSION,
	MODEL_CONFIG_FILE,
	MODEL_FILE,
	MODEL_RELS_FILE,
	NS_BAMBU,
	NS_CORE,
	NS_PRODUCTION,
	OBJECTS_DIR,
	PAINT_ATTRS,
	PART_KEYS,
	PART_SUBTYPE,
	PLATE_KEYS,
	PRINT_LAB_FILE,
	PROJECT_CONFIG_FILE,
	REL_3DMODEL,
	RELATIONSHIPS_FILE,
	type PaintKind
} from './constants';
import { printLabFile } from './printlab-file';
import type {
	ConfigMap,
	ConfigValue,
	CustomGcode,
	MeshId,
	Part,
	Project
} from '$lib/shared/slicer/project';

/** Where the writer gets each mesh's geometry and each `{ path }` passthrough file. */
export interface WriteSources {
	mesh(id: MeshId): MeshGeometry;
	/** Reads a passthrough file stored as `{ path }` (default: read it from disk). */
	file?(path: string): Buffer;
}

// UUID suffixes upstream uses for production-extension ids (bbs_3mf.cpp:288-293).
const OBJECT_UUID_SUFFIX = '-61cb-4c03-9d28-80fed5dfa1dc';
const SUB_OBJECT_UUID_SUFFIX = '-81cb-4c03-9d28-80fed5dfa1dc';
const COMPONENT_UUID_SUFFIX = '-b206-40ff-9872-83e8017abed1';
const BUILD_UUID = '2c7c17d8-22b5-4d84-8835-1976022ea369';
const BUILD_UUID_SUFFIX = '-b1ec-4553-aec9-835e5b724bb4';
const hex8 = (n: number) => (n >>> 0).toString(16).padStart(8, '0');

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';
const MODEL_OPEN = `<model unit="millimeter" xml:lang="en-US" xmlns="${NS_CORE}" xmlns:BambuStudio="${NS_BAMBU}" xmlns:p="${NS_PRODUCTION}" requiredextensions="p">\n`;
const attr = (s: string) => escapeXml(s);
const configText = (v: ConfigValue) => (Array.isArray(v) ? v.join(',') : v);

export function write3mf(project: Project, sources: WriteSources): Buffer {
	const out: [string, Buffer][] = [];
	const put = (path: string, data: string | Buffer) =>
		out.push([path, typeof data === 'string' ? Buffer.from(data, 'utf8') : data]);
	const objects = project.objects;
	if (!objects.length) throw new AppError(400, 'Add something to the project before saving it.');

	// Sub-object ids: one per (mesh, source id) pair, globally unique, because upstream shares meshes
	// between parts by sub-object id (_generate_volumes_new, m_shared_meshes). Source ids are kept when
	// they are free, so a file read and written again keeps its numbering.
	interface Sub {
		id: number;
		mesh: MeshId;
		part: Part;
		file: string;
	}
	const subs = new Map<string, Sub>();
	const partSub = new Map<Part, Sub>();
	const takenSub = new Set<number>();
	const pending: { key: string; part: Part; file: string }[] = [];
	objects.forEach((obj, i) => {
		const file = `${OBJECTS_DIR}object_${i + 1}.model`;
		for (const part of obj.parts) {
			// Painting and face properties live on the sub-object's triangles, so parts painted
			// differently (a painted copy of an object) cannot share one.
			const surface =
				part.paint || part.faceProperties
					? `#${JSON.stringify(part.paint ?? null)}${JSON.stringify(part.faceProperties ?? null)}`
					: '';
			const key = `${part.mesh}#${part.sourceId ?? 'new'}${surface}`;
			const existing = subs.get(key);
			if (existing) {
				partSub.set(part, existing);
				continue;
			}
			const want = part.sourceId;
			if (want !== undefined && want > 0 && !takenSub.has(want)) {
				const sub = { id: want, mesh: part.mesh, part, file };
				takenSub.add(want);
				subs.set(key, sub);
				partSub.set(part, sub);
			} else pending.push({ key, part, file });
		}
	});
	let nextSub = Math.max(0, ...takenSub) + 1;
	for (const p of pending) {
		const existing = subs.get(p.key);
		if (existing) {
			partSub.set(p.part, existing);
			continue;
		}
		const sub = { id: nextSub++, mesh: p.part.mesh, part: p.part, file: p.file };
		subs.set(p.key, sub);
		partSub.set(p.part, sub);
	}

	// Top-level object ids: source ids when unique, the rest numbered after the sub-objects like upstream.
	const topWanted = objects.map((o) => o.sourceId);
	const topIds: number[] = [];
	const takenTop = new Set<number>();
	topWanted.forEach((want, i) => {
		const ok = want !== undefined && want > 0 && topWanted.indexOf(want) === i;
		topIds[i] = ok ? want! : 0;
		if (ok) takenTop.add(want!);
	});
	let nextTop = Math.max(nextSub - 1, ...takenTop) + 1;
	for (let i = 0; i < topIds.length; i++) if (!topIds[i]) topIds[i] = nextTop++;

	// Sub-model files, one per object that first uses a mesh.
	const byFile = new Map<string, Sub[]>();
	for (const sub of subs.values()) {
		const list = byFile.get(sub.file) ?? [];
		list.push(sub);
		byFile.set(sub.file, list);
	}
	for (const [file, list] of byFile) {
		let body = XML_HEAD + MODEL_OPEN;
		body += ` <metadata name="${META_3MF_VERSION}">1</metadata>\n <resources>\n`;
		for (const sub of list) body += objectMesh(sub.id, sub.part, sources.mesh(sub.mesh));
		body += ' </resources>\n <build/>\n</model>\n';
		put(file, body);
	}

	// Root model.
	let model = XML_HEAD + MODEL_OPEN;
	const metadata = new Map<string, string>();
	metadata.set(META_3MF_VERSION, '1');
	for (const [k, v] of Object.entries(project.meta.extras ?? {})) metadata.set(k, v);
	for (const [field, tag] of Object.entries(META) as [keyof typeof META, string][]) {
		const v = project.meta[field];
		if (v !== undefined) metadata.set(tag, v);
	}
	// Sorted by name like upstream's std::map; values escaped twice like upstream (unescaped twice on read).
	for (const [k, v] of [...metadata].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
		model += ` <metadata name="${attr(k)}">${escapeXml(escapeXml(v))}</metadata>\n`;
	model += ' <resources>\n';
	objects.forEach((obj, i) => {
		model += `  <object id="${topIds[i]}" p:UUID="${hex8(i + 1)}${OBJECT_UUID_SUFFIX}" type="model">\n   <components>\n`;
		obj.parts.forEach((part, k) => {
			const sub = partSub.get(part)!;
			model += `    <component p:path="/${attr(sub.file)}" objectid="${sub.id}" p:UUID="${hex8(((i + 1) << 16) | k)}${COMPONENT_UUID_SUFFIX}" transform="${formatTransform(part.transform)}"/>\n`;
		});
		model += '   </components>\n  </object>\n';
	});
	model += ` </resources>\n <build p:UUID="${BUILD_UUID}">\n`;
	let itemNo = 0;
	objects.forEach((obj, i) => {
		for (const inst of obj.instances)
			model += `  <item objectid="${topIds[i]}" p:UUID="${hex8(++itemNo)}${BUILD_UUID_SUFFIX}" transform="${formatTransform(inst.transform)}" printable="${inst.printable && obj.printable ? 1 : 0}"/>\n`;
	});
	model += ' </build>\n</model>\n';
	put(MODEL_FILE, model);

	put(
		MODEL_RELS_FILE,
		XML_HEAD +
			'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
			[...byFile.keys()]
				.map(
					(f, i) =>
						` <Relationship Target="/${attr(f)}" Id="rel-${i + 1}" Type="${REL_3DMODEL}"/>\n`
				)
				.join('') +
			'</Relationships>'
	);

	put(MODEL_CONFIG_FILE, modelSettings(project, topIds, partSub));

	const settings = projectSettings(project);
	if (settings) put(PROJECT_CONFIG_FILE, settings);

	// Per-object side files, by 1-based object order (bbs_3mf.cpp:7842-7920, :8556).
	const heights = objects
		.map((o, i) =>
			o.layerHeightProfile && o.layerHeightProfile.length >= 4
				? `object_id=${i + 1}|${o.layerHeightProfile.map(formatNumber).join(';')}\n`
				: ''
		)
		.join('');
	if (heights) put(LAYER_HEIGHTS_PROFILE_FILE, heights);
	const ranges = objects
		.map((o, i) =>
			o.heightRanges.length
				? ` <object id="${i + 1}">\n` +
					o.heightRanges
						.map(
							(r) =>
								`  <range min_z="${formatNumber(r.minZ)}" max_z="${formatNumber(r.maxZ)}">\n` +
								Object.entries(r.config)
									.map(
										([k, v]) =>
											`   <option opt_key="${attr(k)}">${escapeXml(configText(v))}</option>\n`
									)
									.join('') +
								'  </range>\n'
						)
						.join('') +
					' </object>\n'
				: ''
		)
		.join('');
	if (ranges) put(LAYER_CONFIG_RANGES_FILE, `${XML_HEAD}<objects>\n${ranges}</objects>\n`);
	if (objects.some((o) => o.cutInfo !== undefined))
		put(
			CUT_INFORMATION_FILE,
			`<?xml version="1.0" encoding="utf-8"?>\n<objects>\n` +
				objects
					.map((o, i) =>
						o.cutInfo !== undefined ? ` <object id="${i + 1}">${o.cutInfo}</object>\n` : ''
					)
					.join('') +
				'</objects>\n'
		);

	// Per-plate side files.
	const gcodePlates = project.plates.filter((p) => p.customGcode);
	if (gcodePlates.length)
		put(
			CUSTOM_GCODE_PER_PRINT_Z_FILE,
			`<?xml version="1.0" encoding="utf-8"?>\n<custom_gcodes_per_layer>\n` +
				gcodePlates
					.map(
						(p) =>
							`<plate>\n<plate_info id="${p.index}"/>\n` +
							p
								.customGcode!.items.map(
									(g) =>
										`<layer top_z="${formatNumber(g.topZ)}" type="${g.type}" extruder="${g.extruder}" color="${attr(g.color)}" extra="${attr(g.extra)}" gcode="${attr(legacyGcode(g, project.projectConfig))}"/>\n`
								)
								.join('') +
							(p.customGcode!.mode !== undefined
								? `<mode value="${attr(p.customGcode!.mode)}"/>\n`
								: '') +
							'</plate>\n'
					)
					.join('') +
				'</custom_gcodes_per_layer>\n'
		);
	const sequences = project.plates.filter((p) => p.filamentSequence);
	if (sequences.length)
		put(
			FILAMENT_SEQUENCE_FILE,
			JSON.stringify(
				Object.fromEntries(sequences.map((p) => [`plate_${p.index}`, p.filamentSequence]))
			)
		);

	const lab = printLabFile(project);
	if (lab) put(PRINT_LAB_FILE, lab);

	// Passthrough, then the package files if the project had none (or they point elsewhere).
	const readFile = sources.file ?? ((p: string) => fs.readFileSync(p));
	const written = new Set(out.map(([p]) => p));
	for (const [path, entry] of Object.entries(project.passthrough)) {
		if (written.has(path)) continue;
		put(path, 'base64' in entry ? Buffer.from(entry.base64, 'base64') : readFile(entry.path));
	}
	const names = new Set(out.map(([p]) => p));
	if (!names.has(CONTENT_TYPES_FILE))
		put(
			CONTENT_TYPES_FILE,
			// bbs_3mf.cpp _add_content_types_file_to_archive (:6933).
			XML_HEAD +
				'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
				' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
				' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n' +
				' <Default Extension="png" ContentType="image/png"/>\n' +
				' <Default Extension="gcode" ContentType="text/x.gcode"/>\n' +
				'</Types>'
		);
	if (!names.has(RELATIONSHIPS_FILE)) {
		const thumb = project.plates.find((p) => p.thumbnail && names.has(p.thumbnail))?.thumbnail;
		put(
			RELATIONSHIPS_FILE,
			XML_HEAD +
				'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
				` <Relationship Target="/${MODEL_FILE}" Id="rel-1" Type="${REL_3DMODEL}"/>\n` +
				(thumb
					? ` <Relationship Target="/${attr(thumb)}" Id="rel-2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>\n`
					: '') +
				'</Relationships>'
		);
	}
	// Package files first, like upstream.
	const rank = (p: string) => (p === CONTENT_TYPES_FILE ? 0 : p === RELATIONSHIPS_FILE ? 1 : 2);
	out.sort((a, b) => rank(a[0]) - rank(b[0]));
	return writeZip(out);
}

/**
 * The `gcode` attribute of a custom G-code entry, read only by old slicers (bbs_3mf.cpp
 * _add_custom_gcode_per_print_z_file_to_archive): the pause or template G-code from the settings,
 * "tool_change", or the entry's own G-code.
 */
function legacyGcode(g: CustomGcode, config: ConfigMap): string {
	const setting = (key: string) => {
		const v = config[key];
		return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
	};
	if (g.type === 1) return setting('machine_pause_gcode');
	if (g.type === 4) return setting('template_custom_gcode');
	if (g.type === 3) return 'tool_change';
	return g.extra;
}

/** One sub-object with its mesh and painting (bbs_3mf.cpp _add_mesh_to_object_stream, :7570). */
function objectMesh(id: number, part: Part, g: MeshGeometry): string {
	const type = part.type === 'model' ? 'model' : 'other';
	const lines: string[] = [
		`  <object id="${id}" p:UUID="${hex8(id)}${SUB_OBJECT_UUID_SUFFIX}" type="${type}">\n   <mesh>\n    <vertices>\n`
	];
	const v = g.vertices;
	for (let i = 0; i < v.length; i += 3)
		lines.push(
			`     <vertex x="${formatG9(v[i])}" y="${formatG9(v[i + 1])}" z="${formatG9(v[i + 2])}"/>\n`
		);
	lines.push('    </vertices>\n    <triangles>\n');
	const t = g.triangles;
	const paint = part.paint ?? {};
	const kinds = (Object.keys(PAINT_ATTRS) as PaintKind[]).filter((k) => paint[k]);
	// Upstream's attribute order: supports, fuzzy skin, seam, colour, face property.
	const ordered = (['supports', 'fuzzySkin', 'seam', 'color'] as PaintKind[]).filter((k) =>
		kinds.includes(k)
	);
	for (let i = 0; i < t.length; i += 3) {
		const tri = i / 3;
		let line = `     <triangle v1="${t[i]}" v2="${t[i + 1]}" v3="${t[i + 2]}"`;
		for (const k of ordered) {
			const s = paint[k]![tri];
			if (s) line += ` ${PAINT_ATTRS[k]}="${attr(s)}"`;
		}
		const fp = part.faceProperties?.[tri];
		if (fp) line += ` ${FACE_PROPERTY_ATTR}="${attr(fp)}"`;
		lines.push(line + '/>\n');
	}
	lines.push('    </triangles>\n   </mesh>\n  </object>\n');
	return lines.join('');
}

function modelSettings(project: Project, topIds: number[], partSub: Map<Part, { id: number }>) {
	const meta = (indent: string, key: string, value: string) =>
		`${indent}<metadata key="${attr(key)}" value="${attr(value)}"/>\n`;
	let s = XML_HEAD + '<config>\n';
	project.objects.forEach((obj, i) => {
		s += `  <object id="${topIds[i]}">\n`;
		s += meta('    ', 'name', obj.name);
		if (obj.extras?.module !== undefined) s += meta('    ', 'module', obj.extras.module);
		for (const [k, v] of Object.entries(obj.config)) s += meta('    ', k, configText(v));
		const faces = obj.parts.reduce((n, p) => n + (project.meshes[p.mesh]?.triangles ?? 0), 0);
		s += `    <metadata face_count="${faces}"/>\n`;
		for (const part of obj.parts) {
			s += `    <part id="${partSub.get(part)!.id}" subtype="${PART_SUBTYPE[part.type]}"`;
			if (part.uuid) s += ` ${PART_KEYS.uuid}="${attr(part.uuid)}"`;
			s += '>\n';
			s += meta('      ', PART_KEYS.name, part.name);
			for (const [k, v] of Object.entries(part.source ?? {})) s += meta('      ', k, v);
			if (part.filament !== undefined)
				s += meta('      ', PART_KEYS.extruder, String(part.filament));
			for (const [k, v] of Object.entries(part.config)) s += meta('      ', k, configText(v));
			if (part.text)
				s +=
					'      <text_info' +
					Object.entries(part.text)
						.map(([k, v]) => ` ${attr(k)}="${attr(v)}"`)
						.join('') +
					'/>\n';
			for (const x of part.xml ?? []) s += `      ${x}\n`;
			s += '    </part>\n';
		}
		s += '  </object>\n';
	});
	const objIndex = new Map(project.objects.map((o, i) => [o.id, i]));
	for (const plate of project.plates) {
		s += '  <plate>\n';
		s += meta('    ', PLATE_KEYS.id, String(plate.index));
		s += meta('    ', PLATE_KEYS.name, plate.name);
		s += meta('    ', PLATE_KEYS.locked, String(plate.locked));
		if (plate.bedType !== undefined) s += meta('    ', PLATE_KEYS.bedType, plate.bedType);
		if (plate.printSequence !== undefined)
			s += meta('    ', PLATE_KEYS.printSequence, plate.printSequence);
		if (plate.firstLayerSequence)
			s += meta('    ', PLATE_KEYS.firstLayerSequence, plate.firstLayerSequence.join(' '));
		if (plate.otherLayersSequence)
			s += meta('    ', PLATE_KEYS.otherLayersSequence, plate.otherLayersSequence.join(' '));
		// Upstream reads spiral_mode with std::boolalpha, so write true/false.
		if (plate.spiralVase !== undefined)
			s += meta('    ', PLATE_KEYS.spiral, String(plate.spiralVase));
		if (plate.filamentMapMode !== undefined)
			s += meta('    ', PLATE_KEYS.filamentMapMode, plate.filamentMapMode);
		if (plate.filamentMaps)
			s += meta('    ', PLATE_KEYS.filamentMaps, plate.filamentMaps.join(' '));
		if (plate.thumbnail !== undefined) s += meta('    ', PLATE_KEYS.thumbnail, plate.thumbnail);
		for (const [k, v] of Object.entries(plate.config)) s += meta('    ', k, configText(v));
		for (const ref of plate.instances) {
			const i = objIndex.get(ref.objectId);
			if (i === undefined) continue;
			const k = project.objects[i].instances.findIndex((x) => x.id === ref.instanceId);
			if (k < 0) continue;
			const inst = project.objects[i].instances[k];
			s += '    <model_instance>\n';
			s += meta('      ', INSTANCE_KEYS.objectId, String(topIds[i]));
			s += meta('      ', INSTANCE_KEYS.instanceId, String(k));
			if (inst.identifyId !== undefined)
				s += meta('      ', INSTANCE_KEYS.identifyId, String(inst.identifyId));
			s += '    </model_instance>\n';
		}
		s += '  </plate>\n';
	}
	for (const x of project.modelSettingsXml ?? []) s += `  ${x}\n`;
	return s + '</config>\n';
}

/** project_settings.config: the project's settings plus the preset names and filament colours/types. */
function projectSettings(project: Project): string | null {
	const config: Record<string, ConfigValue> = { ...project.projectConfig };
	const { printer, process } = project.presets;
	const slots = project.filaments.length
		? project.filaments
		: project.presets.filaments.map((preset) => ({ preset, color: '', type: '' }));
	if (printer.name) config.printer_settings_id = printer.name;
	if (process.name) config.print_settings_id = process.name;
	if (slots.length) {
		config.filament_settings_id = slots.map((f) => f.preset.name);
		config.filament_colour = slots.map((f) => f.color);
		config.filament_type = slots.map((f) => f.type);
	}
	// A plain 3MF without settings stays without them.
	if (!Object.keys(config).length) return null;
	return JSON.stringify(config, null, 4) + '\n';
}
