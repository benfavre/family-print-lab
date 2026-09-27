// Request shapes for the slicer project API: the Project JSON (shared/slicer/project.ts) as the
// browser sends it back, with limits. Unknown keys are refused so a typo cannot silently drop data.
import { z } from 'zod';

const text = (max: number) => z.string().max(max);
const id = text(80);
const finite = z.number().finite();
// Per-filament start G-code can be long; the request size limit bounds the total.
const configValue = z.union([text(100_000), z.array(text(100_000)).max(1000)]);
const configMap = z.record(text(200), configValue).refine((m) => Object.keys(m).length <= 2000, {
	message: 'Too many settings.'
});
const stringMap = (max: number) =>
	z.record(text(200), text(max)).refine((m) => Object.keys(m).length <= 500, {
		message: 'Too many entries.'
	});
const sparse = z.record(z.string().regex(/^\d{1,9}$/), text(100_000));
const transform = z.tuple([
	finite,
	finite,
	finite,
	finite,
	finite,
	finite,
	finite,
	finite,
	finite,
	finite,
	finite,
	finite
]);
const meshId = z.string().regex(/^[0-9a-f]{64}$/, 'Not a mesh id.');
const presetRef = z.strictObject({
	kind: z.enum(['printer', 'process', 'filament']),
	name: text(200),
	source: z.enum(['system', 'user', 'project']),
	userPresetId: id.optional()
});

const part = z.strictObject({
	id,
	sourceId: z.number().int().optional(),
	name: text(500),
	type: z.enum(['model', 'negative', 'modifier', 'support_blocker', 'support_enforcer']),
	mesh: meshId,
	transform,
	config: configMap,
	filament: z.number().int().min(0).max(1000).optional(),
	paint: z
		.strictObject({
			supports: sparse.optional(),
			seam: sparse.optional(),
			color: sparse.optional(),
			fuzzySkin: sparse.optional()
		})
		.optional(),
	primitive: z
		.strictObject({
			kind: z.enum(['box', 'cylinder', 'sphere']),
			size: z.tuple([finite, finite, finite])
		})
		.optional(),
	text: stringMap(10_000).optional(),
	uuid: text(80).optional(),
	source: stringMap(5000).optional(),
	faceProperties: sparse.optional(),
	xml: z.array(text(1_000_000)).max(100).optional()
});

const instance = z.strictObject({
	id,
	transform,
	printable: z.boolean(),
	identifyId: z.number().int().optional()
});

const sceneObject = z.strictObject({
	id,
	sourceId: z.number().int().optional(),
	name: text(500),
	parts: z.array(part).min(1).max(1000),
	instances: z.array(instance).min(1).max(1000),
	config: configMap,
	heightRanges: z
		.array(z.strictObject({ minZ: finite, maxZ: finite, config: configMap }))
		.max(1000),
	layerHeightProfile: z.array(finite).max(200_000).optional(),
	printable: z.boolean(),
	extras: stringMap(10_000).optional(),
	cutInfo: text(1_000_000).optional()
});

const plate = z.strictObject({
	index: z.number().int().min(1).max(200),
	name: text(200),
	locked: z.boolean(),
	bedType: text(80).optional(),
	printSequence: z.enum(['by layer', 'by object']).optional(),
	spiralVase: z.boolean().optional(),
	filamentMapMode: text(80).optional(),
	filamentMaps: z.array(z.number().int()).max(1000).optional(),
	firstLayerSequence: z.array(z.number().int()).max(1000).optional(),
	otherLayersSequence: z.array(z.number().int()).max(1000).optional(),
	instances: z.array(z.strictObject({ objectId: id, instanceId: id })).max(10_000),
	config: configMap,
	thumbnail: text(500).optional(),
	customGcode: z
		.strictObject({
			mode: text(80).optional(),
			items: z
				.array(
					z.strictObject({
						topZ: finite,
						type: z.number().int(),
						extruder: z.number().int(),
						color: text(80),
						extra: text(100_000)
					})
				)
				.max(10_000)
		})
		.optional(),
	filamentSequence: z.record(text(200), z.unknown()).optional()
});

export const projectSchema = z.strictObject({
	format: z.literal(1),
	meta: z.strictObject({
		title: text(500),
		designer: text(500).optional(),
		license: text(500).optional(),
		origin: text(2000).optional(),
		description: text(100_000).optional(),
		sourceUrl: text(2000).optional(),
		application: text(200).optional(),
		createdAt: text(80).optional(),
		modifiedAt: text(80).optional(),
		extras: stringMap(100_000).optional()
	}),
	presets: z.strictObject({
		printer: presetRef,
		process: presetRef,
		filaments: z.array(presetRef).max(64)
	}),
	projectConfig: configMap,
	filaments: z
		.array(
			z.strictObject({
				index: z.number().int().min(1).max(64),
				preset: presetRef,
				color: text(80),
				type: text(80),
				tray: z.number().int().nullable().optional(),
				spoolId: id.nullable().optional(),
				nozzle: z
					.union([z.literal(0), z.literal(1)])
					.nullable()
					.optional()
			})
		)
		.max(64),
	plates: z.array(plate).min(1).max(200),
	objects: z.array(sceneObject).max(1000),
	meshes: z.record(
		meshId,
		z.strictObject({
			id: meshId,
			triangles: z.number().int().min(0),
			vertices: z.number().int().min(0),
			bbox: z.tuple([finite, finite, finite, finite, finite, finite]),
			storage: z.union([
				z.strictObject({ kind: z.literal('file'), path: text(4096) }),
				z.strictObject({ kind: z.literal('model-version'), modelId: id, versionId: id })
			])
		})
	),
	passthrough: z.record(
		text(1000),
		z.union([z.strictObject({ path: text(4096) }), z.strictObject({ base64: z.string() })])
	),
	modelSettingsXml: z.array(text(10_000_000)).max(100).optional()
});

export const createFromModels = z.strictObject({
	projectId: id,
	name: z.string().trim().max(120).optional(),
	versions: z
		.array(z.strictObject({ modelId: id, versionId: id }))
		.min(1, 'Choose at least one model.')
		.max(50)
});

export const renameProject = z.strictObject({
	name: z.string().trim().min(1, 'Give it a name.').max(120)
});

export const meshFromModel = z.strictObject({ modelId: id, versionId: id });
