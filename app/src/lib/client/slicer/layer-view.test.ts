import { describe, expect, it } from 'vitest';
import {
	emptyProject,
	IDENTITY,
	type ConfigMap,
	type SceneObject
} from '$lib/shared/slicer/project';
import { encodePaint } from '$lib/shared/slicer/paint';
import { layerColour, layerColourTexture, objectLayerView, objectNozzles } from './layer-view';
import { objectTriangles, slicingParams } from './layers';
import { primitiveSoup } from './primitives';
import { translation } from './matrix';

const config: ConfigMap = {
	layer_height: '0.2',
	nozzle_diameter: ['0.4', '0.6'],
	min_layer_height: ['0.08', '0.12'],
	max_layer_height: ['0.28', '0.42']
};
function object(): SceneObject {
	return {
		id: 'o',
		name: 'Box',
		config: {},
		heightRanges: [],
		printable: true,
		parts: [
			{
				id: 'p',
				name: 'Box',
				type: 'model',
				mesh: 'm',
				transform: [...IDENTITY],
				config: {},
				filament: 1
			}
		],
		instances: [{ id: 'i', transform: [...IDENTITY], printable: true }]
	};
}

describe('physical nozzle layer limits', () => {
	it('intersects the limits of every used nozzle and preserves the nominal height', () => {
		expect(slicingParams(config, 10)).toMatchObject({ minLayerHeight: 0.12, maxLayerHeight: 0.28 });
		expect(slicingParams(config, 10, [2])).toMatchObject({
			minLayerHeight: 0.12,
			maxLayerHeight: 0.42
		});
		expect(slicingParams({ ...config, layer_height: '0.5' }, 10, [1, 2]).maxLayerHeight).toBe(0.5);
		expect(slicingParams({ ...config, layer_height: '0.1' }, 10, [2]).minLayerHeight).toBe(0.1);
	});
	it('uses per-nozzle defaults and the first value when an option vector is short', () => {
		const defaults = slicingParams({ nozzle_diameter: ['0.4', '0.6'] }, 10, [2]);
		expect(defaults.minLayerHeight).toBe(0.07);
		expect(defaults.maxLayerHeight).toBeCloseTo(0.45);
		expect(
			slicingParams({ ...config, min_layer_height: ['0.09'], max_layer_height: ['0.3'] }, 10, [2])
		).toMatchObject({ minLayerHeight: 0.09, maxLayerHeight: 0.3 });
	});
	it('maps material ids to physical nozzles instead of treating each AMS slot as a nozzle', () => {
		const obj = object();
		obj.parts[0].filament = 3;
		expect(objectNozzles(config, obj, [1, 2, 2])).toEqual([2]);
		expect(objectNozzles({ ...config, filament_map: ['1', '2', '2'] }, obj)).toEqual([2]);
		expect(objectNozzles(config, obj, [1, 2, 0])).toEqual([1, 2]);
		expect(objectNozzles(config, obj)).toEqual([1, 2]);
	});
	it('includes painted leaves, part and height-range regions, and enabled supports', () => {
		const obj = object();
		expect(objectNozzles(config, obj, [1, 2])).toEqual([1]);
		obj.parts[0].paint = {
			color: { 0: encodePaint({ split: 1, special: 0, children: [{ state: 1 }, { state: 2 }] }) }
		};
		expect(objectNozzles(config, obj, [1, 2])).toEqual([1, 2]);
		delete obj.parts[0].paint;
		obj.parts[0].config.sparse_infill_filament = '2';
		expect(objectNozzles(config, obj, [1, 2])).toEqual([1, 2]);
		obj.parts[0].config = {};
		obj.heightRanges = [{ minZ: 1, maxZ: 3, config: { extruder: '2' } }];
		expect(objectNozzles(config, obj, [1, 2])).toEqual([1, 2]);
		obj.heightRanges = [];
		expect(objectNozzles({ ...config, support_filament: '2' }, obj, [1, 2])).toEqual([1]);
		expect(
			objectNozzles({ ...config, enable_support: '1', support_filament: '2' }, obj, [1, 2])
		).toEqual([1, 2]);
		expect(
			objectNozzles({ ...config, raft_layers: '2', support_interface_filament: '2' }, obj, [1, 2])
		).toEqual([1, 2]);
	});
	it('combines settings in scope order and uses the selected instance and its plate map', () => {
		const project = emptyProject({
			printer: { kind: 'printer', name: 'P', source: 'system' },
			process: { kind: 'process', name: 'P', source: 'system' },
			filaments: []
		});
		const obj = object();
		obj.instances.push({ id: 'second', transform: translation(0, 0, 7), printable: true });
		obj.instances[1].transform[8] = 2;
		obj.config.layer_height = '0.18';
		project.objects = [obj];
		project.projectConfig.layer_height = '0.16';
		project.plates[0].instances = [{ objectId: 'o', instanceId: 'second' }];
		project.plates[0].config = { layer_height: '0.14', min_layer_height: ['0.08', '0.15'] };
		project.plates[0].filamentMaps = [2];
		const mesh = primitiveSoup('box', [10, 10, 4]);
		const view = objectLayerView(project, obj, config, () => mesh, 'second');
		expect(view).toMatchObject({
			instanceId: 'second',
			nozzles: [2],
			minZ: 3,
			params: { objectHeight: 8, layerHeight: 0.18, minLayerHeight: 0.15, maxLayerHeight: 0.42 }
		});
		const triangles = objectTriangles(obj, () => mesh, 'second')!;
		expect(Math.max(...triangles.filter((_, i) => i % 3 === 2))).toBe(8);
	});
});

describe('layer colour overlay', () => {
	it('uses one clamped colour scale for the legend and the model', () => {
		const params = slicingParams(config, 10);
		expect(layerColour(0, params)).toEqual([56, 126, 232]);
		expect(layerColour(0.2, params)).toEqual([80, 201, 159]);
		expect(layerColour(1, params)).toEqual([239, 157, 50]);
	});
	it('samples interior bands even when the bottom and top have the same height', () => {
		const params = slicingParams(config, 10);
		const pixels = layerColourTexture({ params, profile: [0, 0.28, 5, 0.12, 10, 0.28] }, 3);
		expect([...pixels]).toEqual([239, 157, 50, 255, 56, 126, 232, 255, 239, 157, 50, 255]);
		expect(() => layerColourTexture({ params, profile: [] }, 1)).toThrow(RangeError);
	});
});
