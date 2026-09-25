// Domain vocabulary shared by the server and the UI.

export const PROJECT_STATUSES = ['Idea', 'Planned', 'Printing', 'Done'] as const;
export const JOB_STATUSES = ['Queued', 'Printing', 'Succeeded', 'Failed', 'Cancelled'] as const;
export const CATEGORIES = ['Office', 'Home lab', 'Home', 'Creative'] as const;
export const PROFILE_COLORS = ['violet', 'blue', 'orange', 'pink', 'green'] as const;
/** Kid mode levels: 'little' (about 3–6, pictures first) and 'junior' (about 7–12). */
export const KID_LEVELS = ['little', 'junior'] as const;
export const KID_LEVEL_LABEL: Record<KidLevel, string> = {
	little: 'Little maker (about 3–6)',
	junior: 'Junior maker (about 7–12)'
};
export const PRINT_REQUEST_STATUSES = ['Waiting', 'Approved', 'Declined'] as const;
export const MATERIALS = [
	'PLA',
	'PLA Matte',
	'PLA Silk',
	'PLA-CF',
	'PETG',
	'PETG-CF',
	'ABS',
	'ASA',
	'TPU',
	'PA',
	'PC',
	'Other'
] as const;
export const PLATES = [
	'Textured PEI',
	'Smooth PEI',
	'Cool plate',
	'Engineering plate',
	'Other'
] as const;
export const LAYER_HEIGHTS = ['0.08', '0.12', '0.16', '0.20', '0.24', '0.28'] as const;
export const NOZZLES = ['0.2', '0.4', '0.6', '0.8'] as const;
export const SUPPORTS = ['None', 'Normal', 'Tree'] as const;
export const STARTER_STEPS = [
	'Measure the space and constraints',
	'Choose or design a model',
	'Check license, size and fit',
	'Slice and save the project file',
	'Test print',
	'Install or hand it over'
];

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export type JobStatus = (typeof JOB_STATUSES)[number];
export type Category = (typeof CATEGORIES)[number];
export type ProfileColor = (typeof PROFILE_COLORS)[number];
export type KidLevel = (typeof KID_LEVELS)[number];
export type PrintRequestStatus = (typeof PRINT_REQUEST_STATUSES)[number];

export const STATUS_META: Record<ProjectStatus, string> = {
	Idea: 'Concept',
	Planned: 'Model chosen',
	Printing: 'On the plate',
	Done: 'Made'
};
export const CATEGORY_GLYPH: Record<Category, string> = {
	Office: '▤',
	'Home lab': '⌬',
	Home: '⌂',
	Creative: '✦'
};
export const FINISHED_JOB = new Set<JobStatus>(['Succeeded', 'Failed', 'Cancelled']);
export const CONSUMING_JOB = new Set<JobStatus>(['Succeeded', 'Failed']);

export interface Profile {
	id: string;
	name: string;
	age: number | null;
	color: ProfileColor;
	interests: string;
	/** Set when this profile uses kid mode. */
	kid: KidLevel | null;
	version: number;
	createdAt: string;
	updatedAt: string;
}

/** A child's request for a grown-up to print something they made. */
export interface PrintRequest {
	id: string;
	projectId: string;
	profileId: string;
	modelVersionId: string | null;
	spoolId: string | null;
	status: PrintRequestStatus;
	message: string;
	reply: string;
	jobId: string | null;
	decidedAt: string | null;
	version: number;
	createdAt: string;
	updatedAt: string;
}

export interface ChecklistItem {
	id: string;
	text: string;
	done: boolean;
}

export interface Project {
	id: string;
	profileId: string;
	title: string;
	status: ProjectStatus;
	category: Category;
	description: string;
	notes: string;
	url: string;
	files: string;
	material: string;
	pinned: boolean;
	checklist: ChecklistItem[];
	version: number;
	createdAt: string;
	updatedAt: string;
}

export interface Spool {
	id: string;
	brand: string;
	material: string;
	colorName: string;
	colorHex: string;
	totalGrams: number;
	remainingGrams: number;
	cost: number | null;
	notes: string;
	version: number;
	createdAt: string;
	updatedAt: string;
}

export interface SlicedFilament {
	/** 1-based filament number in the sliced project. */
	id: number;
	type: string;
	color: string;
	grams: number;
	meters: number;
}
export interface SlicedPlate {
	index: number;
	/** Path of the plate's G-code inside the file, e.g. Metadata/plate_1.gcode. */
	gcode: string;
	md5: string;
	minutes: number;
	grams: number;
	layers: number;
	supports: boolean;
	filaments: SlicedFilament[];
}
/** A sliced print file attached to a job, ready to send to the printer. */
export interface SlicedInfo {
	/** Stored file name (under data/sliced). */
	file: string;
	/** What the person called it (the uploaded file name, or the model's name). */
	name: string;
	size: number;
	plates: SlicedPlate[];
	/** The plate this job prints. */
	plate: number;
	printerModelId: string;
	slicer: string;
	/** 'upload' (sliced in Bambu Studio by hand) or 'app' (sliced here). */
	source: 'upload' | 'app';
	at: string;
}

export interface Job {
	id: string;
	projectId: string;
	status: JobStatus;
	revision: string;
	spoolId: string | null;
	material: string;
	grams: number | null;
	minutes: number | null;
	actualMinutes: number | null;
	layerHeight: string;
	nozzle: string;
	plate: string;
	supports: string;
	infill: number | null;
	notes: string;
	printerTask: string;
	modelVersionId: string | null;
	/** The sliced file this job will send to the printer, if one is attached. */
	sliced: SlicedInfo | null;
	chargeSpoolId: string | null;
	chargeGrams: number;
	version: number;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	updatedAt: string;
}

export interface ModelVersionSummary {
	id: string;
	number: number;
	note: string;
	origin: string;
	triangles: number;
	sizeX: number;
	sizeY: number;
	sizeZ: number;
	volume: number;
	hasThumbnail: boolean;
	createdAt: string;
}

/** A hand-drawn sketch attached to a project (the PNG is fetched separately). */
export interface SketchSummary {
	id: string;
	projectId: string;
	title: string;
	width: number;
	height: number;
	version: number;
	createdAt: string;
	updatedAt: string;
}

export interface ModelSummary {
	id: string;
	projectId: string;
	name: string;
	kind: 'parametric' | 'mesh';
	currentVersionId: string | null;
	versions: ModelVersionSummary[];
	version: number;
	createdAt: string;
	updatedAt: string;
}

export interface Activity {
	id: number;
	at: string;
	kind: string;
	message: string;
	projectId: string | null;
	jobId: string | null;
}

export interface Workspace {
	profiles: Profile[];
	projects: Project[];
	jobs: Job[];
	spools: Spool[];
	activity: Activity[];
	models: ModelSummary[];
	sketches: SketchSummary[];
	printRequests: PrintRequest[];
	/** Whether a parent PIN is set (kid mode needs one). */
	parentPin: boolean;
	/** Monotonic change counter; bumps on every committed write. */
	changeId: number;
}

export interface PrinterTray {
	slot: string;
	active: boolean;
	type: string;
	name: string;
	color: string | null;
	remain: number | null;
}

export interface PrinterSnapshot {
	gcodeState: string;
	percent: number | null;
	remainingMinutes: number | null;
	layer: number | null;
	totalLayers: number | null;
	nozzle: number | null;
	nozzleTarget: number | null;
	bed: number | null;
	bedTarget: number | null;
	chamber: number | null;
	task: string;
	speedLevel: number | null;
	printError: number;
	hms: { attr: number | null; code: number | null }[];
	wifiSignal: string;
	ams: { unit: string; humidity: number | null; trays: PrinterTray[] }[];
}

export interface PrinterStatus {
	configured: boolean;
	name?: string;
	simulated?: boolean;
	connected?: boolean;
	lastSeen?: string | null;
	error?: string;
	warning?: string;
	printing?: boolean;
	state?: PrinterSnapshot | null;
}

export const ACTIVE_PRINTER_STATES = new Set(['PREPARE', 'RUNNING', 'PAUSE', 'SLICING']);
