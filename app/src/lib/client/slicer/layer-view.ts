// The editor and the colour overlay share object/plate settings and physical nozzle limits.
// Includes the object's materials, height ranges, painted regions and enabled supports, following
// origin: BambuStudio src/libslic3r/PrintObject.cpp @ 926a7192574bcb9b3a732e1ec59a46d79cb45466
import type { ConfigMap, Project, SceneObject } from '$lib/shared/slicer/project';
import { decodePaint, paintStates } from '$lib/shared/slicer/paint';
import { instanceBox, type MeshSource } from './edit';
import { effectiveProfile, heightAt, slicingParams, type SlicingParams } from './layers';

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const positive = (value: string | string[] | undefined) => {
	const n = Number(first(value));
	return Number.isInteger(n) && n > 0 ? n : null;
};

/** Filament ids are not nozzle indices: one AMS may feed many filaments into the same nozzle. */
export function objectNozzles(config: ConfigMap, object: SceneObject, map?: number[]): number[] {
	const count = Array.isArray(config.nozzle_diameter)
		? Math.max(1, config.nozzle_diameter.length)
		: 1;
	if (count === 1) return [1];
	const all = Array.from({ length: count }, (_, i) => i + 1);
	const filaments = new Set<number>();
	const regionKeys = ['wall_filament', 'sparse_infill_filament', 'solid_infill_filament'];
	const collect = (settings: ConfigMap) => {
		for (const key of regionKeys) {
			const id = positive(settings[key]);
			if (id) filaments.add(id);
		}
	};
	for (const part of object.parts) {
		if (part.type !== 'model' && part.type !== 'modifier') continue;
		filaments.add(
			part.filament || positive(part.config.extruder) || positive(config.extruder) || 1
		);
		collect({ ...config, ...part.config });
		for (const painted of Object.values(part.paint?.color ?? {})) {
			try {
				for (const state of paintStates(decodePaint(painted))) if (state > 0) filaments.add(state);
			} catch {
				return all;
			}
		}
	}
	for (const range of object.heightRanges) {
		collect(range.config);
		const id = positive(range.config.extruder);
		if (id) filaments.add(id);
	}
	if (
		first(config.enable_support) === '1' ||
		positive(config.raft_layers) ||
		positive(config.enforce_support_layers)
	) {
		for (const key of ['support_filament', 'support_interface_filament']) {
			const id = positive(config[key]);
			if (id) filaments.add(id); // zero follows the object's current material.
		}
	}
	const configured = config.filament_map;
	const mapping = map ?? (Array.isArray(configured) ? configured.map(Number) : undefined);
	const nozzles = new Set<number>();
	for (const filament of filaments) {
		const nozzle = mapping?.[filament - 1];
		// Auto assignment has not been resolved yet: either nozzle may be chosen by the engine.
		if (!Number.isInteger(nozzle) || !nozzle || nozzle < 1 || nozzle > count) return all;
		nozzles.add(nozzle);
	}
	return nozzles.size ? [...nozzles].sort((a, b) => a - b) : all;
}

export function objectLayerView(
	project: Project,
	object: SceneObject,
	defaults: ConfigMap,
	meshes: MeshSource,
	instanceId?: string
) {
	const instance = object.instances.find((i) => i.id === instanceId) ?? object.instances[0];
	const plate = project.plates.find((p) =>
		p.instances.some((i) => i.objectId === object.id && i.instanceId === instance?.id)
	);
	const config = { ...defaults, ...project.projectConfig, ...plate?.config, ...object.config };
	const box = instance
		? instanceBox(project, object, instance.transform, meshes)
		: [0, 0, 0, 0, 0, 0];
	const nozzles = objectNozzles(config, object, plate?.filamentMaps);
	const params = slicingParams(config, Math.round((box[5] - box[2]) * 1e5) / 1e5, nozzles);
	return {
		objectId: object.id,
		instanceId: instance?.id ?? '',
		minZ: box[2],
		nozzles,
		params,
		profile: effectiveProfile(object.layerHeightProfile, object.heightRanges, params)
	};
}

export type LayerView = ReturnType<typeof objectLayerView>;

/** A shared blue → green → amber scale for the model and its numeric legend. */
export function layerColour(height: number, params: SlicingParams): [number, number, number] {
	const span = params.maxLayerHeight - params.minLayerHeight;
	const t = span > 0 ? Math.min(1, Math.max(0, (height - params.minLayerHeight) / span)) : 0.5;
	const stops = [
		[56, 126, 232],
		[80, 201, 159],
		[239, 157, 50]
	];
	const index = t < 0.5 ? 0 : 1;
	return stops[index].map((v, c) =>
		Math.round(v + (stops[index + 1][c] - v) * (t * 2 - index))
	) as [number, number, number];
}

/** A lookup sampled in the fragment shader, so large triangles show small height bands too. */
export function layerColourTexture(
	view: Pick<LayerView, 'params' | 'profile'>,
	size = 1024
): Uint8Array {
	if (!Number.isInteger(size) || size < 2)
		throw new RangeError('A layer colour texture needs at least two samples.');
	const pixels = new Uint8Array(size * 4);
	for (let i = 0; i < size; i++) {
		const height = heightAt(view.profile, (view.params.objectHeight * i) / (size - 1));
		pixels.set([...layerColour(height, view.params), 255], i * 4);
	}
	return pixels;
}
