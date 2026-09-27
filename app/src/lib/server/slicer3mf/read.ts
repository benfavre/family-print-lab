// Reads a Bambu Studio / OrcaSlicer project 3MF (and PrusaSlicer or plain 3MF) into the Project model.
// Follows upstream's importer (src/libslic3r/Format/bbs_3mf.cpp, _BBS_3MF_Importer, v02.08.02.61):
// build items become objects and instances in item order, components become parts, model_settings.config
// names them and holds per-object/per-part settings and plates, and per-object side files are indexed by
// the 1-based object order. Files we do not model are kept byte for byte in `passthrough`.
//
// origin: BambuStudio src/libslic3r/Format/bbs_3mf.cpp @ 926a7192574bcb9b3a732e1ec59a46d79cb45466
import { restoreLayerProfile } from './layer-profile';
import { readZip } from '../cad/mesh';
import { AppError } from '../validation';
import { child, childrenNamed, parseXml, rootElement, xmlUnescape, type XmlNode } from './xml';
import {
	canonicalStl,
	fromSoup,
	meshIdOf,
	meshInfo,
	scanMesh,
	sliceTriangles,
	toSoup,
	type MeshGeometry,
	type ScannedMesh
} from './mesh';
import {
	CUSTOM_GCODE_PER_PRINT_Z_FILE,
	CUT_INFORMATION_FILE,
	FILAMENT_SEQUENCE_FILE,
	INSTANCE_KEYS,
	LAYER_CONFIG_RANGES_FILE,
	LAYER_HEIGHTS_PROFILE_FILE,
	META,
	META_3MF_VERSION,
	MODEL_CONFIG_FILE,
	MODEL_FILE,
	MODELLED_FILES,
	PART_KEYS,
	PART_SOURCE_KEYS,
	PLATE_KEYS,
	PRINT_LAB_FILE,
	PROJECT_CONFIG_FILE,
	PRUSA_LAYER_CONFIG_RANGES_FILE,
	PRUSA_LAYER_HEIGHTS_PROFILE_FILE,
	PRUSA_MODEL_CONFIG_FILE,
	REL_3DMODEL,
	RELATIONSHIPS_FILE,
	partTypeFrom,
	type PaintKind
} from './constants';
import {
	IDENTITY,
	type ConfigMap,
	type CustomGcode,
	type FilamentSlot,
	type HeightRange,
	type Instance,
	type MeshId,
	type MeshRef,
	type Part,
	type Plate,
	type PresetRef,
	type Project,
	type SceneObject,
	type Transform
} from '$lib/shared/slicer/project';
import { composeTransforms, parseTransform } from './transform';
import { parsePrintLabFile } from './printlab-file';

export interface ReadOptions {
	/** Storage recorded in each MeshRef (default: a file named <sha256>.stl). */
	meshStorage?: (id: MeshId) => MeshRef['storage'];
	/** Cap on the unpacked size of the whole archive (default MAX_UNPACKED_BYTES). */
	maxUnpackedBytes?: number;
}

export interface ReadResult {
	project: Project;
	/** Every mesh the project uses, as canonical binary STL (its sha256 is the MeshId). */
	meshes: Map<MeshId, { stl: Buffer; geometry: MeshGeometry }>;
	/** Things we could read around (for logs and the import summary). */
	warnings: string[];
}

const bad = (why: string) => new AppError(400, why);
/** What a project may unpack to in all (a 100 MB upload of well-compressed meshes stays far below). */
export const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;
const META_FIELDS = Object.entries(META) as [keyof typeof META, string][];

interface ModelDoc {
	path: string;
	text: string;
	objects: Map<number, XmlNode>;
}

interface Leaf {
	doc: ModelDoc;
	id: number;
	node: XmlNode;
	transform: Transform;
}

/** Per-object entry of model_settings.config (or PrusaSlicer's Slic3r_PE_model.config). */
interface ObjectSettings {
	metadata: [string, string][];
	volumes: VolumeSettings[];
}
interface VolumeSettings {
	id: number;
	first: number;
	last: number;
	subtype?: string;
	uuid?: string;
	metadata: [string, string][];
	text?: Record<string, string>;
	xml: string[];
}

export function read3mf(buf: Buffer, o: ReadOptions = {}): ReadResult {
	try {
		return readProject(buf, o);
	} catch (error) {
		if (error instanceof AppError) throw error;
		// Broken XML or JSON inside the archive: say so instead of failing with a server error.
		throw bad(`That 3MF could not be read: ${(error as Error).message}`);
	}
}

function readProject(buf: Buffer, o: ReadOptions): ReadResult {
	const files = readZip(
		buf,
		(n) => (n.endsWith('/') ? false : 'all'),
		o.maxUnpackedBytes ?? MAX_UNPACKED_BYTES
	);
	const warnings: string[] = [];
	const text = (path: string) => {
		const b = files.get(path);
		return b ? b.toString('utf8') : null;
	};

	// The root model: the 3D model relationship in _rels/.rels, else 3D/3dmodel.model.
	let rootPath = MODEL_FILE;
	const rels = text(RELATIONSHIPS_FILE);
	if (rels) {
		const rel = childrenNamed(rootElement(parseXml(rels)), 'Relationship').find(
			(r) => r.attrs.Type === REL_3DMODEL
		);
		if (rel?.attrs.Target) rootPath = rel.attrs.Target.replace(/^\//, '');
	}
	if (!files.has(rootPath)) {
		const any = [...files.keys()].find((n) => /^3D\/[^/]+\.model$/i.test(n));
		if (!any) throw bad('That file has no 3D model in it.');
		rootPath = any;
	}

	const docs = new Map<string, ModelDoc>();
	const consumed = new Set<string>([rootPath]);
	const doc = (path: string): ModelDoc | null => {
		const cached = docs.get(path);
		if (cached) return cached;
		const t = text(path);
		if (t === null) return null;
		consumed.add(path);
		const model = rootElement(parseXml(t, new Set(['mesh'])));
		const objects = new Map<number, XmlNode>();
		for (const obj of childrenNamed(child(model, 'resources') ?? model, 'object'))
			objects.set(Number(obj.attrs.id), obj);
		const d = { path, text: t, objects };
		docs.set(path, d);
		return d;
	};
	const root = doc(rootPath)!;
	const rootModel = rootElement(parseXml(root.text, new Set(['mesh', 'resources'])));

	// Model metadata (Bambu writes it escaped twice; upstream unescapes after parsing: _handle_end_metadata).
	const meta: Project['meta'] = { title: '' };
	const extras: Record<string, string> = {};
	let hasTitle = false;
	for (const m of childrenNamed(rootModel, 'metadata')) {
		const name = m.attrs.name;
		if (!name) continue;
		const value = xmlUnescape(m.text);
		const field = META_FIELDS.find(([, tag]) => tag === name)?.[0];
		if (field === 'title') {
			meta.title = value;
			hasTitle = true;
		} else if (field) meta[field] = value;
		else if (!(name === META_3MF_VERSION && value === '1')) extras[name] = value;
	}
	if (!hasTitle) meta.title = '';
	if (Object.keys(extras).length) meta.extras = extras;

	// Objects in the order of their first build item, like upstream's _create_object_instance.
	const build = child(rootModel, 'build');
	const order: number[] = [];
	const items = new Map<number, XmlNode[]>();
	for (const item of build ? childrenNamed(build, 'item') : []) {
		const id = Number(item.attrs.objectid);
		if (!root.objects.has(id)) {
			warnings.push(`Build item for missing object ${item.attrs.objectid} skipped.`);
			continue;
		}
		if (!items.has(id)) {
			items.set(id, []);
			order.push(id);
		}
		items.get(id)!.push(item);
	}
	if (!order.length) throw bad('That 3MF has nothing on its build plate.');

	const settings = readModelSettings(
		text(MODEL_CONFIG_FILE) ?? text(PRUSA_MODEL_CONFIG_FILE),
		warnings
	);

	const meshes: ReadResult['meshes'] = new Map();
	const storage = o.meshStorage ?? ((id: MeshId) => ({ kind: 'file' as const, path: `${id}.stl` }));
	const meshRefs: Record<MeshId, MeshRef> = {};
	const addMesh = (g: MeshGeometry): MeshId => {
		const soup = toSoup(g);
		const stl = canonicalStl(soup);
		const id = meshIdOf(stl);
		if (!meshes.has(id)) {
			// Keep the geometry as the STL reads back (float32, merged vertices) so writes are stable.
			const geometry = fromSoup(soup);
			meshes.set(id, { stl, geometry });
			meshRefs[id] = meshInfo(id, geometry, storage(id));
		}
		return id;
	};
	const scanned = new Map<string, ScannedMesh>();
	const scanLeaf = (leaf: Leaf): ScannedMesh => {
		const key = `${leaf.doc.path}#${leaf.id}`;
		let s = scanned.get(key);
		if (!s) {
			const mesh = child(leaf.node, 'mesh')!;
			try {
				s = scanMesh(leaf.doc.text.slice(mesh.innerStart, mesh.innerEnd));
			} catch (e) {
				throw bad(`Object ${leaf.id} in ${leaf.doc.path}: ${(e as Error).message}`);
			}
			scanned.set(key, s);
		}
		return s;
	};

	const objects: SceneObject[] = [];
	const topIds = new Map<number, SceneObject>();
	order.forEach((topId, index) => {
		const node = root.objects.get(topId)!;
		const objId = `o${index + 1}`;
		const leaves = collectLeaves(root, topId, node, IDENTITY, doc, warnings, 0);
		const objSettings = settings.objects.get(topId);
		const config: ConfigMap = {};
		const objExtras: Record<string, string> = {};
		let name: string | undefined;
		for (const [k, v] of objSettings?.metadata ?? []) {
			if (k === 'name') name = v;
			else if (k === 'module') objExtras.module = v;
			else config[k] = v;
		}
		name ??= node.attrs.name || `Object_${index + 1}`;

		const parts: Part[] = [];
		const volumes = objSettings?.volumes ?? [];
		const byRange = volumes.length > 0 && volumes.some((v) => v.last > 0);
		let unnamed = 0;
		const makePart = (
			k: number,
			v: VolumeSettings | undefined,
			geometry: MeshGeometry,
			paint: ScannedMesh['paint'],
			faceProperties: Record<number, string>,
			transform: Transform,
			sourceId: number | undefined
		) => {
			const part: Part = {
				id: `${objId}-p${k + 1}`,
				name: '',
				type: partTypeFrom(v?.subtype),
				mesh: addMesh(geometry),
				transform,
				config: {}
			};
			if (sourceId !== undefined) part.sourceId = sourceId;
			if (v?.uuid) part.uuid = v.uuid;
			let partName: string | undefined;
			const source: Record<string, string> = {};
			for (const [key, value] of v?.metadata ?? []) {
				if (key === PART_KEYS.name) partName = value;
				else if (key === PART_KEYS.volumeType || key === PART_KEYS.partType)
					part.type = partTypeFrom(value);
				else if (key === 'modifier') {
					if (value === '1') part.type = 'modifier';
				} else if (key === PART_KEYS.uuid) part.uuid = value;
				else if (key === PART_KEYS.meshShared) continue;
				else if (key === PART_KEYS.extruder && /^-?\d+$/.test(value)) part.filament = Number(value);
				else if (PART_SOURCE_KEYS.has(key)) source[key] = value;
				else part.config[key] = value;
			}
			// Upstream names unnamed parts after the object (_generate_volumes_new, "renamed_volumes_count").
			part.name = partName ?? (unnamed++ ? `${name}_${unnamed}` : name!);
			if (Object.keys(source).length) part.source = source;
			const paintData = Object.fromEntries(
				Object.entries(paint).filter(([, m]) => m && Object.keys(m).length)
			) as Part['paint'];
			if (paintData && Object.keys(paintData).length) part.paint = paintData;
			if (Object.keys(faceProperties).length) part.faceProperties = faceProperties;
			if (v?.text) part.text = v.text;
			if (v?.xml.length) part.xml = v.xml;
			parts.push(part);
		};

		if (byRange) {
			// PrusaSlicer (and old Bambu) style: one mesh per object, parts are triangle ranges of it.
			const leaf = leaves[0];
			if (!leaf || leaves.length > 1) throw bad(`Object ${topId} mixes triangle ranges and parts.`);
			const s = scanLeaf(leaf);
			const count = s.triangles.length / 3;
			volumes.forEach((v, k) => {
				if (v.first > v.last || v.last >= count)
					throw bad(`Object ${topId} has a part outside its mesh.`);
				const shift = (m: Record<number, string> | undefined) => {
					const out: Record<number, string> = {};
					for (const [t, value] of Object.entries(m ?? {}))
						if (Number(t) >= v.first && Number(t) <= v.last) out[Number(t) - v.first] = value;
					return out;
				};
				const paint: ScannedMesh['paint'] = {};
				for (const kind of Object.keys(s.paint) as PaintKind[]) paint[kind] = shift(s.paint[kind]);
				makePart(
					k,
					v,
					sliceTriangles(s, v.first, v.last),
					paint,
					shift(s.faceProperties),
					leaf.transform,
					// The sub-object id our writer gives it, so a converted file reads back the same.
					k + 1
				);
			});
		} else {
			leaves.forEach((leaf, k) => {
				// Upstream matches a part's settings by position first, then by sub-object id.
				const v = volumes[k]?.id === leaf.id ? volumes[k] : volumes.find((x) => x.id === leaf.id);
				const s = scanLeaf(leaf);
				if (!s.triangles.length) throw bad(`Object ${leaf.id} has an empty mesh.`);
				makePart(k, v, s, s.paint, s.faceProperties, leaf.transform, leaf.id);
			});
		}
		if (!parts.length) throw bad(`Object ${topId} has no mesh.`);

		const instances: Instance[] = items.get(topId)!.map((item, k) => ({
			id: `${objId}-i${k + 1}`,
			transform: item.attrs.transform
				? (parseTransform(item.attrs.transform) ??
					(warnings.push(`Object ${topId} has a bad transform.`), IDENTITY))
				: IDENTITY,
			printable: item.attrs.printable !== '0' && item.attrs.printable !== 'false'
		}));
		const obj: SceneObject = {
			id: objId,
			sourceId: topId,
			name,
			parts,
			instances,
			config,
			heightRanges: [],
			printable: instances.some((i) => i.printable)
		};
		if (Object.keys(objExtras).length) obj.extras = objExtras;
		objects.push(obj);
		topIds.set(topId, obj);
	});

	// Per-object side files, indexed by 1-based object order (bbs_3mf.cpp:2205-2212, :2298).
	const layerHeights = text(LAYER_HEIGHTS_PROFILE_FILE) ?? text(PRUSA_LAYER_HEIGHTS_PROFILE_FILE);
	if (layerHeights)
		for (const line of layerHeights.split('\n')) {
			const m = /^object_id=(\d+)\|(.*)$/.exec(line.trim());
			if (!m) continue;
			const values = m[2].split(';').map(Number);
			const obj = objects[Number(m[1]) - 1];
			if (obj && values.length >= 4 && values.length % 2 === 0 && values.every(Number.isFinite))
				obj.layerHeightProfile = values;
			else warnings.push(`Layer height profile ${m[1]} skipped.`);
		}
	const ranges = text(LAYER_CONFIG_RANGES_FILE) ?? text(PRUSA_LAYER_CONFIG_RANGES_FILE);
	if (ranges)
		for (const o of childrenNamed(rootElement(parseXml(ranges)), 'object')) {
			const obj = objects[Number(o.attrs.id) - 1];
			if (!obj) continue;
			obj.heightRanges = childrenNamed(o, 'range').map((r): HeightRange => ({
				minZ: Number(r.attrs.min_z),
				maxZ: Number(r.attrs.max_z),
				config: Object.fromEntries(
					childrenNamed(r, 'option').map((opt) => [opt.attrs.opt_key, opt.text])
				)
			}));
		}
	const cut = text(CUT_INFORMATION_FILE);
	if (cut)
		for (const o of childrenNamed(rootElement(parseXml(cut)), 'object')) {
			const obj = objects[Number(o.attrs.id) - 1];
			if (obj) obj.cutInfo = cut.slice(o.innerStart, o.innerEnd);
		}

	// Plates (model_settings.config); a file without any gets one plate holding everything.
	const plates: Plate[] = settings.plates.map((p) => plateFrom(p, topIds, warnings));
	// Plate numbers are 1-based and unique (upstream: plate_index = plater_id); a plate without a
	// usable one gets the next free number instead of clashing with another.
	const usedIndex = new Set<number>();
	const renumber: Plate[] = [];
	for (const plate of plates) {
		if (plate.index >= 1 && !usedIndex.has(plate.index)) usedIndex.add(plate.index);
		else renumber.push(plate);
	}
	let freeIndex = 1;
	for (const plate of renumber) {
		while (usedIndex.has(freeIndex)) freeIndex++;
		warnings.push(`A plate numbered ${plate.index} was renumbered ${freeIndex}.`);
		plate.index = freeIndex;
		usedIndex.add(freeIndex);
	}
	if (!plates.length)
		plates.push({
			index: 1,
			name: '',
			locked: false,
			instances: objects.flatMap((o) =>
				o.instances.map((i) => ({ objectId: o.id, instanceId: i.id }))
			),
			config: {}
		});
	plates.sort((a, b) => a.index - b.index);

	const gcodes = text(CUSTOM_GCODE_PER_PRINT_Z_FILE);
	if (gcodes) readCustomGcode(gcodes, plates);
	const sequence = text(FILAMENT_SEQUENCE_FILE);
	if (sequence) {
		try {
			const j = JSON.parse(sequence) as Record<string, unknown>;
			for (const plate of plates) {
				const entry = j[`plate_${plate.index}`];
				if (entry && typeof entry === 'object' && !Array.isArray(entry))
					plate.filamentSequence = entry as Record<string, unknown>;
			}
		} catch {
			warnings.push('filament_sequence.json is not valid JSON; left out.');
		}
	}

	// Presets and filaments from project_settings.config (JSON).
	const { projectConfig, presets, filaments } = readProjectConfig(
		text(PROJECT_CONFIG_FILE),
		warnings
	);
	const printLab = parsePrintLabFile(text(PRINT_LAB_FILE));
	if (printLab) {
		objects.forEach((object, i) => {
			const restored = restoreLayerProfile(
				object.layerHeightProfile,
				printLab.layerHeightProfiles?.[i]
			);
			if (restored) object.layerHeightProfile = restored;
		});
		const keep = (ref: PresetRef, saved: PresetRef | undefined) =>
			saved && saved.name === ref.name && saved.kind === ref.kind ? saved : ref;
		presets.printer = keep(presets.printer, printLab.presets?.printer);
		presets.process = keep(presets.process, printLab.presets?.process);
		presets.filaments = presets.filaments.map((f, i) => keep(f, printLab.presets?.filaments?.[i]));
		filaments.forEach((f, i) => {
			f.preset = presets.filaments[i] ?? f.preset;
			const extra = printLab.filaments?.[i];
			if (extra?.tray !== undefined) f.tray = extra.tray;
			if (extra?.spoolId !== undefined) f.spoolId = extra.spoolId;
			if (extra?.nozzle !== undefined) f.nozzle = extra.nozzle;
		});
	}

	// Everything else passes through byte for byte.
	const passthrough: Project['passthrough'] = {};
	for (const [path, data] of files) {
		if (consumed.has(path) || MODELLED_FILES.has(path) || path === PRINT_LAB_FILE) continue;
		if (/^3D\/.*\.model$/i.test(path)) continue; // unreferenced sub-models are not part of the project
		if (path === RELATIONSHIPS_FILE && rootPath !== MODEL_FILE) continue; // rewritten for 3D/3dmodel.model
		passthrough[path] = { base64: data.toString('base64') };
	}

	const project: Project = {
		format: 1,
		meta,
		presets,
		projectConfig,
		filaments,
		plates,
		objects,
		meshes: meshRefs,
		passthrough
	};
	if (settings.extraXml.length) project.modelSettingsXml = settings.extraXml;
	return { project, meshes, warnings };
}

/** The mesh-carrying objects under an object, with their transforms relative to it (components flattened). */
function collectLeaves(
	d: ModelDoc,
	id: number,
	node: XmlNode,
	transform: Transform,
	doc: (path: string) => ModelDoc | null,
	warnings: string[],
	depth: number
): Leaf[] {
	if (depth > 16) throw bad('That 3MF nests its objects too deeply.');
	if (child(node, 'mesh')) return [{ doc: d, id, node, transform }];
	const components = child(node, 'components');
	if (!components) return [];
	const out: Leaf[] = [];
	for (const c of childrenNamed(components, 'component')) {
		const path = c.attrs['p:path']?.replace(/^\//, '');
		const target = path ? doc(path) : d;
		const cid = Number(c.attrs.objectid);
		const cnode = target?.objects.get(cid);
		if (!target || !cnode) {
			warnings.push(`Component ${c.attrs.objectid} of object ${id} is missing.`);
			continue;
		}
		const ct = c.attrs.transform ? (parseTransform(c.attrs.transform) ?? IDENTITY) : IDENTITY;
		// Points map as p · C_child · C_parent (row vectors, 3MF core spec).
		out.push(
			...collectLeaves(
				target,
				cid,
				cnode,
				composeTransforms(ct, transform),
				doc,
				warnings,
				depth + 1
			)
		);
	}
	return out;
}

interface PlateSettings {
	metadata: [string, string][];
	instances: [string, string][][];
}

function readModelSettings(xml: string | null, warnings: string[]) {
	const objects = new Map<number, ObjectSettings>();
	const plates: PlateSettings[] = [];
	const extraXml: string[] = [];
	if (!xml) return { objects, plates, extraXml };
	const config = rootElement(parseXml(xml));
	const pairs = (n: XmlNode) =>
		childrenNamed(n, 'metadata')
			.filter((m) => m.attrs.key)
			.map((m) => [m.attrs.key, m.attrs.value ?? ''] as [string, string]);
	for (const el of config.children) {
		if (el.name === 'object') {
			const volumes: VolumeSettings[] = [];
			for (const v of el.children.filter((c) => c.name === 'part' || c.name === 'volume')) {
				const xmlKids: string[] = [];
				let text: Record<string, string> | undefined;
				for (const c of v.children) {
					if (c.name === 'metadata') continue;
					if (c.name === 'text_info') text = { ...c.attrs };
					else xmlKids.push(xml.slice(c.start, c.end));
				}
				volumes.push({
					id: Number(v.attrs.id ?? -1),
					first: Number(v.attrs.firstid ?? 0),
					last: Number(v.attrs.lastid ?? 0),
					subtype: v.attrs.subtype,
					uuid: v.attrs.uuid,
					metadata: pairs(v),
					text,
					xml: xmlKids
				});
			}
			const id = Number(el.attrs.id);
			if (objects.has(id)) warnings.push(`Settings for object ${id} appear twice.`);
			else objects.set(id, { metadata: pairs(el), volumes });
		} else if (el.name === 'plate') {
			plates.push({
				metadata: pairs(el),
				instances: childrenNamed(el, 'model_instance').map(pairs)
			});
		} else extraXml.push(xml.slice(el.start, el.end));
	}
	return { objects, plates, extraXml };
}

const ints = (s: string) =>
	s
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map(Number)
		.filter((n) => Number.isInteger(n));

function plateFrom(p: PlateSettings, topIds: Map<number, SceneObject>, warnings: string[]): Plate {
	const plate: Plate = { index: 0, name: '', locked: false, instances: [], config: {} };
	for (const [key, value] of p.metadata) {
		switch (key) {
			case PLATE_KEYS.id:
				plate.index = Number(value) || 0;
				break;
			case PLATE_KEYS.name:
				plate.name = xmlUnescape(value); // upstream unescapes plater_name
				break;
			case PLATE_KEYS.locked:
				plate.locked = value === 'true' || value === '1';
				break;
			case PLATE_KEYS.bedType:
				plate.bedType = value;
				break;
			case PLATE_KEYS.printSequence:
				if (value === 'by layer' || value === 'by object') plate.printSequence = value;
				else plate.config[key] = value;
				break;
			case PLATE_KEYS.spiral:
				plate.spiralVase = value === 'true' || value === '1';
				break;
			case PLATE_KEYS.filamentMapMode:
				plate.filamentMapMode = value;
				break;
			case PLATE_KEYS.filamentMaps:
				plate.filamentMaps = ints(value);
				break;
			case PLATE_KEYS.firstLayerSequence:
				plate.firstLayerSequence = ints(value);
				break;
			case PLATE_KEYS.otherLayersSequence:
				plate.otherLayersSequence = ints(value);
				break;
			case PLATE_KEYS.thumbnail:
				plate.thumbnail = value;
				break;
			default:
				plate.config[key] = value;
		}
	}
	for (const inst of p.instances) {
		const get = (k: string) => inst.find(([key]) => key === k)?.[1];
		const obj = topIds.get(Number(get(INSTANCE_KEYS.objectId)));
		const instance = obj?.instances[Number(get(INSTANCE_KEYS.instanceId))];
		if (!obj || !instance) {
			warnings.push(`Plate ${plate.index} lists an instance that is not in the model.`);
			continue;
		}
		const identify = get(INSTANCE_KEYS.identifyId);
		if (identify !== undefined && /^-?\d+$/.test(identify)) instance.identifyId = Number(identify);
		if (plate.instances.some((r) => r.objectId === obj.id && r.instanceId === instance.id))
			continue;
		plate.instances.push({ objectId: obj.id, instanceId: instance.id });
	}
	return plate;
}

function readCustomGcode(xml: string, plates: Plate[]) {
	const root = rootElement(parseXml(xml));
	if (root.name !== 'custom_gcodes_per_layer') return;
	const read = (n: XmlNode) => {
		const items: CustomGcode[] = [];
		let mode: string | undefined;
		for (const c of n.children) {
			if (c.name === 'mode') mode = c.attrs.value;
			if (c.name !== 'layer') continue;
			let type = Number(c.attrs.type);
			let extra = c.attrs.extra ?? '';
			if (c.attrs.type === undefined) {
				// PrusaSlicer 2.2 and older (bbs_3mf.cpp _extract_custom_gcode_per_print_z_from_archive).
				const g = c.attrs.gcode ?? '';
				type = g === 'M600' ? 0 : g === 'M601' ? 1 : g === 'tool_change' ? 3 : 2;
				extra = type === 1 ? (c.attrs.color ?? '') : type === 2 ? g : '';
			}
			items.push({
				topZ: Number(c.attrs.top_z),
				type,
				extruder: Number(c.attrs.extruder),
				color: c.attrs.color ?? '',
				extra
			});
		}
		return { items, mode };
	};
	const perPlate = childrenNamed(root, 'plate');
	const entries = perPlate.length
		? perPlate.map((p) => ({ id: Number(child(p, 'plate_info')?.attrs.id ?? -1), ...read(p) }))
		: [{ id: 1, ...read(root) }];
	for (const e of entries) {
		const plate = plates.find((p) => p.index === e.id);
		if (!plate) continue;
		plate.customGcode = { items: e.items };
		if (e.mode !== undefined) plate.customGcode.mode = e.mode;
	}
}

/** Keys the writer rebuilds from presets and filament slots. */
export const PRESET_CONFIG_KEYS = [
	'printer_settings_id',
	'print_settings_id',
	'filament_settings_id',
	'filament_colour',
	'filament_type'
];

function readProjectConfig(json: string | null, warnings: string[]) {
	let raw: Record<string, unknown> = {};
	if (json) {
		try {
			const parsed = JSON.parse(json);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed;
		} catch {
			warnings.push('project_settings.config is not valid JSON; settings left out.');
		}
	}
	const str = (v: unknown) => (typeof v === 'string' ? v : '');
	const arr = (v: unknown) =>
		Array.isArray(v) ? v.map(str) : typeof v === 'string' && v ? [v] : [];
	const ref = (kind: PresetRef['kind'], name: string): PresetRef => ({
		kind,
		name,
		source: 'project'
	});
	const filamentIds = arr(raw.filament_settings_id);
	const colours = arr(raw.filament_colour);
	const types = arr(raw.filament_type);
	const n = Math.max(filamentIds.length, colours.length, types.length);
	const presets = {
		printer: ref('printer', str(raw.printer_settings_id)),
		process: ref('process', str(raw.print_settings_id)),
		filaments: Array.from({ length: n }, (_, i) => ref('filament', filamentIds[i] ?? ''))
	};
	const filaments: FilamentSlot[] = presets.filaments.map((preset, i) => ({
		index: i + 1,
		preset,
		color: colours[i] ?? '',
		type: types[i] ?? ''
	}));
	const projectConfig: ConfigMap = {};
	for (const [k, v] of Object.entries(raw)) {
		if (PRESET_CONFIG_KEYS.includes(k)) continue;
		if (typeof v === 'string') projectConfig[k] = v;
		else if (Array.isArray(v))
			projectConfig[k] = v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
		else projectConfig[k] = JSON.stringify(v);
	}
	return { projectConfig, presets, filaments };
}
