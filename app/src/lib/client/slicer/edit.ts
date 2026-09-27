// Changes the workspace makes to a Project (shared/slicer/project.ts), as plain functions on a draft
// the caller has cloned (the undo stack keeps the clones). Names and defaults follow Bambu Studio's
// model (ModelObject, ModelVolume, ModelInstance, PartPlate) so the saved 3MF reads back there.
import {
	IDENTITY,
	type ConfigMap,
	type ConfigValue,
	type FilamentSlot,
	type HeightRange,
	type MeshRef,
	type Part,
	type PartType,
	type Plate,
	type Project,
	type SceneObject,
	type Transform
} from '$lib/shared/slicer/project';
import type { ArrangeAnswer, BedShape, OrientAnswer } from '$lib/shared/slicer-ui';
import { boundsOf, compose, translate, translation, unionBox, type Box } from './matrix';
import { plateAt, plateCentre, plateOf, plateOrigin, relayout } from './plates';

/** A mesh's triangles (x y z per vertex), when the browser has loaded it. */
export type MeshSource = (meshId: string) => Float32Array | undefined;

/** An id not used yet among `taken`, as `${prefix}${n}`. */
export function freshId(prefix: string, taken: Iterable<string>): string {
	const used = new Set(taken);
	let n = 1;
	while (used.has(`${prefix}${n}`)) n++;
	return `${prefix}${n}`;
}

const allIds = (p: Project) =>
	p.objects.flatMap((o) => [o.id, ...o.parts.map((x) => x.id), ...o.instances.map((i) => i.id)]);

export function findObject(project: Project, objectId: string): SceneObject {
	const obj = project.objects.find((o) => o.id === objectId);
	if (!obj) throw new Error('That object is no longer in the project.');
	return obj;
}

/** The box of a part under a transform: exact when the mesh is loaded, else from its stored bounds. */
function partBox(project: Project, part: Part, t: Transform, meshes?: MeshSource): Box {
	const loaded = meshes?.(part.mesh);
	if (loaded) return boundsOf(loaded, t);
	const b = project.meshes[part.mesh]?.bbox ?? [0, 0, 0, 0, 0, 0];
	const corners = new Float32Array(24);
	let k = 0;
	for (const x of [b[0], b[3]])
		for (const y of [b[1], b[4]]) for (const z of [b[2], b[5]]) corners.set([x, y, z], k++ * 3);
	return boundsOf(corners, t);
}

/** An instance's box on the bed (model parts only, as Bambu Studio's instance bounding box). */
export function instanceBox(
	project: Project,
	obj: SceneObject,
	instance: Transform,
	meshes?: MeshSource
): Box {
	const parts = obj.parts.filter((p) => p.type === 'model');
	return unionBox(
		(parts.length ? parts : obj.parts).map((p) =>
			partBox(project, p, compose(p.transform, instance), meshes)
		)
	);
}

/**
 * Adds a mesh as a new object on a plate: one model part, one instance, centred on the plate and
 * resting on it. Returns the object.
 */
export function addObject(
	project: Project,
	o: { name: string; mesh: MeshRef; plate: number; bed: BedShape; at?: [number, number] }
): SceneObject {
	const taken = allIds(project);
	const id = freshId('o', taken);
	const b = o.mesh.bbox;
	const [cx, cy] = o.at ?? plateCentre(o.bed, project.plates.length, o.plate);
	const obj: SceneObject = {
		id,
		name: o.name.slice(0, 200) || 'Object',
		parts: [
			{
				id: `${id}-p1`,
				name: o.name.slice(0, 200) || 'Object',
				type: 'model',
				mesh: o.mesh.id,
				transform: [...IDENTITY],
				config: {}
			}
		],
		instances: [
			{
				id: `${id}-i1`,
				transform: translation(cx - (b[0] + b[3]) / 2, cy - (b[1] + b[4]) / 2, -b[2]),
				printable: true
			}
		],
		config: {},
		heightRanges: [],
		printable: true
	};
	project.meshes[o.mesh.id] = o.mesh;
	project.objects.push(obj);
	plateByIndex(project, o.plate).instances.push({ objectId: id, instanceId: `${id}-i1` });
	return obj;
}

export function plateByIndex(project: Project, index: number): Plate {
	const plate = project.plates.find((p) => p.index === index);
	if (!plate) throw new Error(`There is no plate ${index}.`);
	return plate;
}

/** Removes objects and their plate entries; meshes nobody uses go too. */
export function removeObjects(project: Project, ids: string[]) {
	const gone = new Set(ids);
	project.objects = project.objects.filter((o) => !gone.has(o.id));
	for (const plate of project.plates)
		plate.instances = plate.instances.filter((i) => !gone.has(i.objectId));
	pruneMeshes(project);
}

function pruneMeshes(project: Project) {
	const used = new Set(project.objects.flatMap((o) => o.parts.map((p) => p.mesh)));
	for (const id of Object.keys(project.meshes)) if (!used.has(id)) delete project.meshes[id];
}

/**
 * Copies objects (Bambu Studio's copy and paste: a new object with the same parts and settings), each
 * placed `offset` mm to the right on the same plate. Upstream ids (source ids, uuids, skip-object ids)
 * are not copied: the copy is a new object. Returns the new ids.
 */
export function duplicateObjects(project: Project, ids: string[], offset = 10): string[] {
	const made: string[] = [];
	for (const id of ids) {
		const src = findObject(project, id);
		const taken = allIds(project);
		const nid = freshId('o', taken);
		const copy = plainCopy(src);
		copy.id = nid;
		delete copy.sourceId;
		delete copy.cutInfo;
		copy.parts = copy.parts.map((p, k) => {
			const part = { ...p, id: `${nid}-p${k + 1}` };
			delete part.sourceId;
			delete part.uuid;
			return part;
		});
		const width = (() => {
			const b = instanceBox(project, src, src.instances[0].transform);
			return b[3] - b[0];
		})();
		copy.instances = src.instances.map((inst, k) => ({
			id: `${nid}-i${k + 1}`,
			transform: translate(inst.transform, width + offset, 0),
			printable: inst.printable
		}));
		project.objects.push(copy);
		src.instances.forEach((inst, k) => {
			const plate = plateOf(project, src.id, inst.id) ?? project.plates[0].index;
			plateByIndex(project, plate).instances.push({
				objectId: nid,
				instanceId: `${nid}-i${k + 1}`
			});
		});
		made.push(nid);
	}
	return made;
}

/** A deep copy that also works on Svelte state proxies. */
function plainCopy<T>(v: T): T {
	return JSON.parse(JSON.stringify(v)) as T;
}

/** Sets an instance's transform and moves it to the plate it now stands on (by its centre). */
export function placeInstance(
	project: Project,
	bed: BedShape,
	objectId: string,
	instanceId: string,
	transform: Transform,
	meshes?: MeshSource
) {
	const obj = findObject(project, objectId);
	const inst = obj.instances.find((i) => i.id === instanceId);
	if (!inst) throw new Error('That instance is no longer in the project.');
	inst.transform = transform;
	const b = instanceBox(project, obj, transform, meshes);
	const target = plateAt(bed, project.plates.length, (b[0] + b[3]) / 2, (b[1] + b[4]) / 2);
	const current = plateOf(project, objectId, instanceId);
	if (target !== null && target !== current) {
		for (const plate of project.plates)
			plate.instances = plate.instances.filter(
				(i) => !(i.objectId === objectId && i.instanceId === instanceId)
			);
		plateByIndex(project, target).instances.push({ objectId, instanceId });
	}
}

/** Adds an empty plate at the end (the grid may widen: plates move with their objects). */
export function addPlate(project: Project, bed: BedShape): Plate {
	const before = project.plates.length;
	const index = Math.max(0, ...project.plates.map((p) => p.index)) + 1;
	const plate: Plate = { index, name: '', locked: false, instances: [], config: {} };
	project.plates.push(plate);
	relayout(project, bed, before);
	return plate;
}

/** Removes a plate and what stands on it; later plates move up one number and into place. */
export function removePlate(project: Project, bed: BedShape, index: number) {
	if (project.plates.length <= 1) throw new Error('A project needs at least one plate.');
	const plate = plateByIndex(project, index);
	const before = project.plates.length;
	removeObjects(
		project,
		project.objects
			.filter((o) => o.instances.every((i) => plateOf(project, o.id, i.id) === index))
			.map((o) => o.id)
	);
	// Objects with other instances elsewhere only lose the instances on this plate.
	for (const ref of plate.instances) {
		const obj = project.objects.find((o) => o.id === ref.objectId);
		if (obj) obj.instances = obj.instances.filter((i) => i.id !== ref.instanceId);
	}
	project.plates = project.plates.filter((p) => p.index !== index);
	const renumber = new Map<number, number>();
	project.plates.sort((a, b) => a.index - b.index);
	project.plates.forEach((p, i) => {
		renumber.set(p.index, i + 1);
		p.index = i + 1;
	});
	relayout(project, bed, before, renumber);
}

export function setPlate(
	project: Project,
	index: number,
	patch: Partial<Omit<Plate, 'index' | 'instances'>>
) {
	Object.assign(plateByIndex(project, index), patch);
}

/** The generated shapes Bambu Studio offers as modifiers (Add modifier → Box, Cylinder, Sphere). */
export type Primitive = NonNullable<Part['primitive']>['kind'];

/**
 * Adds a part to an object: a modifier, negative part or support blocker/enforcer, placed at the
 * middle of the object (in the object's own coordinates, where its parts' volume matrices live).
 */
export function addPart(
	project: Project,
	objectId: string,
	o: {
		name: string;
		type: PartType;
		mesh: MeshRef;
		primitive?: Part['primitive'];
		meshes?: MeshSource;
	}
): Part {
	const obj = findObject(project, objectId);
	const local = unionBox(
		obj.parts
			.filter((p) => p.type === 'model')
			.map((p) => partBox(project, p, p.transform, o.meshes))
	);
	const b = o.mesh.bbox;
	const centre = [(local[0] + local[3]) / 2, (local[1] + local[4]) / 2, (local[2] + local[5]) / 2];
	const part: Part = {
		id: freshId(`${obj.id}-p`, allIds(project)),
		name: o.name,
		type: o.type,
		mesh: o.mesh.id,
		transform: translation(
			centre[0] - (b[0] + b[3]) / 2,
			centre[1] - (b[1] + b[4]) / 2,
			centre[2] - (b[2] + b[5]) / 2
		),
		config: {}
	};
	if (o.primitive) part.primitive = o.primitive;
	project.meshes[o.mesh.id] = o.mesh;
	obj.parts.push(part);
	return part;
}

/** Removes a part; an object keeps at least one model part (delete the object instead). */
export function removePart(project: Project, objectId: string, partId: string) {
	const obj = findObject(project, objectId);
	const part = obj.parts.find((p) => p.id === partId);
	if (!part) return;
	if (part.type === 'model' && obj.parts.filter((p) => p.type === 'model').length === 1)
		throw new Error('An object needs at least one part. Delete the object instead.');
	obj.parts = obj.parts.filter((p) => p.id !== partId);
	pruneMeshes(project);
}

/** Sets (or with undefined, clears) one setting in a config map. */
export function setConfig(config: ConfigMap, key: string, value: ConfigValue | undefined) {
	if (value === undefined || value === '') delete config[key];
	else config[key] = value;
}

/** Height ranges stay sorted and apart, like layer_config_ranges (ModelObject::layer_config_ranges). */
export function addHeightRange(obj: SceneObject, height: number): HeightRange {
	const top = Math.max(0, ...obj.heightRanges.map((r) => r.maxZ));
	const range: HeightRange = {
		minZ: top,
		maxZ: Math.round((top + Math.max(0.2, Math.min(2, height - top || 2))) * 100) / 100,
		config: {}
	};
	obj.heightRanges.push(range);
	obj.heightRanges.sort((a, b) => a.minZ - b.minZ);
	return range;
}

/** Problems with an object's height ranges, in plain words (empty: fine). */
export function heightRangeProblems(obj: SceneObject): string[] {
	const out: string[] = [];
	const sorted = [...obj.heightRanges].sort((a, b) => a.minZ - b.minZ);
	sorted.forEach((r, i) => {
		if (!(r.maxZ > r.minZ)) out.push(`The range from ${r.minZ} mm must end above where it starts.`);
		const next = sorted[i + 1];
		if (next && next.minZ < r.maxZ)
			out.push(`The ranges ${r.minZ}–${r.maxZ} mm and ${next.minZ}–${next.maxZ} mm overlap.`);
	});
	return out;
}

/**
 * The filament slots, keeping the preset selection in step (project_settings writes one
 * filament_settings_id per slot) and parts that pointed past the last slot on slot 1.
 */
export function setFilaments(project: Project, slots: FilamentSlot[]) {
	project.filaments = slots.map((s, i) => ({ ...s, index: i + 1 }));
	project.presets = { ...project.presets, filaments: project.filaments.map((s) => s.preset) };
	const count = slots.length;
	for (const obj of project.objects) {
		const extruder = Number(obj.config.extruder);
		if (Number.isInteger(extruder) && extruder > count) obj.config.extruder = '1';
		for (const part of obj.parts)
			if (part.filament !== undefined && part.filament > count) part.filament = 1;
	}
}

/** The filament an object prints with (its extruder setting, default 1). */
export function objectFilament(obj: SceneObject): number {
	const n = Number(obj.config.extruder);
	return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** The filament a part prints with (its own, else its object's). */
export function partFilament(obj: SceneObject, part: Part): number {
	return part.filament && part.filament >= 1 ? part.filament : objectFilament(obj);
}

/** The backend's arrangement, applied: new transforms and plate membership. */
export function applyArrange(project: Project, answer: ArrangeAnswer) {
	for (const a of answer.instances) {
		const obj = project.objects.find((o) => o.id === a.objectId);
		const inst = obj?.instances.find((i) => i.id === a.instanceId);
		if (!inst) continue;
		inst.transform = a.transform;
		if (plateOf(project, a.objectId, a.instanceId) === a.plate) continue;
		if (!project.plates.some((p) => p.index === a.plate)) continue;
		for (const plate of project.plates)
			plate.instances = plate.instances.filter(
				(i) => !(i.objectId === a.objectId && i.instanceId === a.instanceId)
			);
		plateByIndex(project, a.plate).instances.push({
			objectId: a.objectId,
			instanceId: a.instanceId
		});
	}
}

/** The backend's orientation, applied to each object's first instance (as its answer describes). */
export function applyOrient(project: Project, answer: OrientAnswer) {
	for (const a of answer.objects) {
		const obj = project.objects.find((o) => o.id === a.objectId);
		if (obj?.instances[0]) obj.instances[0].transform = a.transform;
	}
}

/** Everything on a plate that sticks out of the printable area (plain words for the slice button). */
export function outsidePlate(project: Project, bed: BedShape, meshes?: MeshSource): string[] {
	const out: string[] = [];
	for (const plate of project.plates) {
		const [ox, oy] = plateOrigin(bed, project.plates.length, plate.index);
		for (const ref of plate.instances) {
			const obj = project.objects.find((o) => o.id === ref.objectId);
			const inst = obj?.instances.find((i) => i.id === ref.instanceId);
			if (!obj || !inst) continue;
			const b = instanceBox(project, obj, inst.transform, meshes);
			const eps = 0.01;
			if (
				b[0] < ox + bed.area[0] - eps ||
				b[1] < oy + bed.area[1] - eps ||
				b[3] > ox + bed.area[2] + eps ||
				b[4] > oy + bed.area[3] + eps ||
				b[5] > bed.height + eps
			)
				out.push(`${obj.name} does not fit on plate ${plate.index}.`);
			else if (b[2] < -eps) out.push(`${obj.name} goes below the bed on plate ${plate.index}.`);
		}
	}
	return out;
}

/** The world point of an object's first instance's middle (pivot for turning it). */
export function instanceCentre(
	project: Project,
	obj: SceneObject,
	t: Transform,
	meshes?: MeshSource
) {
	const b = instanceBox(project, obj, t, meshes);
	return [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2] as [number, number, number];
}
