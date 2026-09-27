// File names, element names and metadata keys of Bambu Studio / OrcaSlicer project 3MFs. Source:
// src/libslic3r/Format/bbs_3mf.cpp at Bambu Studio v02.08.02.61 (slicer/upstream.lock); the line
// numbers below refer to that file. PrusaSlicer names come from src/libslic3r/Format/3mf.cpp at
// PrusaSlicer version_2.8.1.
//
// origin: BambuStudio src/libslic3r/Format/bbs_3mf.cpp @ 926a7192574bcb9b3a732e1ec59a46d79cb45466
// origin: PrusaSlicer src/libslic3r/Format/3mf.cpp @ 5dc04b4e8f14f65bbcc5377d62cad3e86c2aea36
//   (version_2.8.1)
import type { PartType } from '$lib/shared/slicer/project';

// Archive paths (bbs_3mf.cpp:151-190).
export const MODEL_FILE = '3D/3dmodel.model'; // :153
export const MODEL_RELS_FILE = '3D/_rels/3dmodel.model.rels'; // :154
export const OBJECTS_DIR = '3D/Objects/';
export const CONTENT_TYPES_FILE = '[Content_Types].xml'; // :161
export const RELATIONSHIPS_FILE = '_rels/.rels'; // :162
export const PROJECT_CONFIG_FILE = 'Metadata/project_settings.config'; // :171
export const MODEL_CONFIG_FILE = 'Metadata/model_settings.config'; // :172
export const FILAMENT_SEQUENCE_FILE = 'Metadata/filament_sequence.json'; // :175
export const LAYER_HEIGHTS_PROFILE_FILE = 'Metadata/layer_heights_profile.txt'; // :179
export const LAYER_CONFIG_RANGES_FILE = 'Metadata/layer_config_ranges.xml'; // :180
export const CUSTOM_GCODE_PER_PRINT_Z_FILE = 'Metadata/custom_gcode_per_layer.xml'; // :184
export const CUT_INFORMATION_FILE = 'Metadata/cut_information.xml'; // :190
/** Ours: what a 3MF cannot say (AMS trays, spools, user preset ids). Other slicers ignore it. */
export const PRINT_LAB_FILE = 'Metadata/print_lab.json';
// PrusaSlicer (3mf.cpp:86-93): read, then written back in Bambu's names.
export const PRUSA_MODEL_CONFIG_FILE = 'Metadata/Slic3r_PE_model.config';
export const PRUSA_LAYER_HEIGHTS_PROFILE_FILE = 'Metadata/Slic3r_PE_layer_heights_profile.txt';
export const PRUSA_LAYER_CONFIG_RANGES_FILE = 'Metadata/Prusa_Slicer_layer_config_ranges.xml';

/** Files the reader turns into the Project and the writer regenerates (everything else passes through). */
export const MODELLED_FILES = new Set([
	MODEL_FILE,
	MODEL_RELS_FILE,
	PROJECT_CONFIG_FILE,
	MODEL_CONFIG_FILE,
	FILAMENT_SEQUENCE_FILE,
	LAYER_HEIGHTS_PROFILE_FILE,
	LAYER_CONFIG_RANGES_FILE,
	CUSTOM_GCODE_PER_PRINT_Z_FILE,
	CUT_INFORMATION_FILE,
	PRUSA_MODEL_CONFIG_FILE,
	PRUSA_LAYER_HEIGHTS_PROFILE_FILE,
	PRUSA_LAYER_CONFIG_RANGES_FILE
]);

// Namespaces and relationship types (bbs_3mf.cpp:7182-7185, :7065).
export const NS_CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
export const NS_BAMBU = 'http://schemas.bambulab.com/package/2021';
export const NS_PRODUCTION = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
export const REL_3DMODEL = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';
export const REL_THUMBNAIL =
	'http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail';

// Painting attributes on <triangle> (bbs_3mf.cpp:316-321; PrusaSlicer 3mf.cpp:132-134).
export type PaintKind = 'supports' | 'seam' | 'color' | 'fuzzySkin';
export const PAINT_ATTRS: Record<PaintKind, string> = {
	supports: 'paint_supports',
	seam: 'paint_seam',
	color: 'paint_color',
	fuzzySkin: 'paint_fuzzy_skin'
};
export const PRUSA_PAINT_ATTRS: Partial<Record<PaintKind, string>> = {
	supports: 'slic3rpe:custom_supports',
	seam: 'slic3rpe:custom_seam',
	color: 'slic3rpe:mmu_segmentation'
};
export const FACE_PROPERTY_ATTR = 'face_property'; // :321

// Model metadata names in 3dmodel.model (bbs_3mf.cpp:111, :122-137).
export const META_3MF_VERSION = 'BambuStudio:3mfVersion';
export const META = {
	title: 'Title',
	designer: 'Designer',
	license: 'License',
	origin: 'Origin',
	description: 'Description',
	application: 'Application',
	createdAt: 'CreationDate',
	modifiedAt: 'ModificationDate',
	// Not an upstream tag: where the model came from (MakerWorld, Printables…), kept by us.
	sourceUrl: 'SourceUrl'
} as const;

// Part subtypes (Model.cpp ModelVolume::type_to_string / type_from_string).
export const PART_SUBTYPE: Record<PartType, string> = {
	model: 'normal_part',
	negative: 'negative_part',
	modifier: 'modifier_part',
	support_blocker: 'support_blocker',
	support_enforcer: 'support_enforcer'
};
export function partTypeFrom(s: string | undefined): PartType {
	switch (s) {
		case 'negative_part':
		case 'NegativeVolume': // PrusaSlicer Model.cpp type_from_string
			return 'negative';
		case 'modifier_part':
		case 'ParameterModifier':
		case '1':
			return 'modifier';
		case 'support_blocker':
		case 'SupportBlocker':
			return 'support_blocker';
		case 'support_enforcer':
		case 'SupportEnforcer':
			return 'support_enforcer';
		default:
			return 'model';
	}
}

// model_settings.config keys (bbs_3mf.cpp:329-389).
export const PART_KEYS = {
	name: 'name', // :374
	volumeType: 'volume_type', // :375
	partType: 'part_type', // :376
	matrix: 'matrix', // :377
	meshShared: 'mesh_shared', // :387
	uuid: 'uuid', // :389
	extruder: 'extruder'
} as const;
/** Part metadata kept in Part.source (bbs_3mf.cpp:377-390). */
export const PART_SOURCE_KEYS = new Set([
	'matrix',
	'source_file',
	'source_object_id',
	'source_volume_id',
	'source_offset_x',
	'source_offset_y',
	'source_offset_z',
	'source_in_inches',
	'source_in_meters',
	'source_is_builtin_volume', // PrusaSlicer 3mf.cpp:156
	'assembly_src_guid'
]);
export const PLATE_KEYS = {
	id: 'plater_id', // :349
	name: 'plater_name', // :350
	locked: 'locked', // :328
	bedType: 'bed_type', // :329
	printSequence: 'print_sequence', // :330
	firstLayerSequence: 'first_layer_print_sequence', // :331
	otherLayersSequence: 'other_layers_print_sequence', // :332
	spiral: 'spiral_mode', // :334
	filamentMapMode: 'filament_map_mode', // :335
	filamentMaps: 'filament_maps', // :336
	thumbnail: 'thumbnail_file' // :340
} as const;
export const INSTANCE_KEYS = {
	objectId: 'object_id', // :346
	instanceId: 'instance_id', // :347
	identifyId: 'identify_id' // :348
} as const;
