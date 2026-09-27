// The slicer workspace (slicer-ui) as the browser sees it: which backend slices and what it can do, the
// bed the chosen printer preset has, and what slicing a plate gave. The project itself is the Project
// model (shared/slicer/project.ts), stored by slicer-3mf.
import type { SlicedPlate } from './domain';
import type { EngineCapability, EngineInfo, PlateStats } from './slicer/protocol';
import type { Transform } from './slicer/project';

/** GET /api/slicer-ui/info. */
export interface SlicerBackend {
	/** null: no slicer is installed (the workspace still edits and saves projects). */
	engine: EngineInfo['engine'] | null;
	version: string | null;
	capabilities: EngineCapability[];
	/** Whether the print queue is running (Send offers "Add to queue"). */
	queue: boolean;
	/** Whether slicer-profiles is running (preset lists, printer defaults). */
	profiles: boolean;
}

/** POST /api/slicer-ui/bed: the printable area of a printer preset, in mm. */
export interface BedShape {
	/** [minX, minY, maxX, maxY] from printable_area. */
	area: [number, number, number, number];
	/** printable_height. */
	height: number;
	/** printer_model of the preset ("Bambu Lab P1S"), '' when unknown. */
	printerModel: string;
}

/** One sliced plate kept by the workspace until the project changes. */
export interface PlateResult {
	plate: number;
	/** The project revision it was sliced from; a newer save makes it stale. */
	revision: number;
	stats: PlateStats;
	/** The plate as the printer file describes it (time, grams, filaments). */
	sliced: SlicedPlate;
	backend: EngineInfo['engine'];
	/** Printer model code in the file (slice_info printer_model_id). */
	printerModelId: string;
	/** Whether a toolpath preview is kept for it. */
	preview: boolean;
	at: string;
}

/** GET /api/slicer-ui/[id]/results. */
export interface ResultsView {
	revision: number;
	results: PlateResult[];
}

/** POST /api/slicer-ui/[id]/arrange. */
export interface ArrangeAnswer {
	instances: { objectId: string; instanceId: string; plate: number; transform: Transform }[];
}

/** POST /api/slicer-ui/[id]/orient. */
export interface OrientAnswer {
	objects: { objectId: string; transform: Transform }[];
}

/** POST /api/slicer-ui/[id]/send. */
export interface SendAnswer {
	jobId: string;
	/** true: added to the print queue; false: the send window opens for a direct send. */
	queued: boolean;
}

/** Live channel slicer-ui:progress while a plate slices. */
export interface SliceProgress {
	slicerProjectId: string;
	plate: number;
	taskId: string;
	percent: number;
	message: string;
}
