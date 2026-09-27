// AI print checks (modules/ai-vision): types shared by the server and the pages.
import type { AiProviderId } from './integrations';

export const VISION_VERDICTS = ['ok', 'spaghetti', 'detached', 'blob', 'unsure'] as const;
export type VisionVerdict = (typeof VISION_VERDICTS)[number];
/** Verdicts that mean something went wrong (the rest never raise an alert). */
export const VISION_PROBLEMS: readonly VisionVerdict[] = ['spaghetti', 'detached', 'blob'];

export const VERDICT_LABEL: Record<VisionVerdict, string> = {
	ok: 'Looks fine',
	spaghetti: 'Spaghetti',
	detached: 'Part came loose',
	blob: 'Blob on the nozzle',
	unsure: 'Not sure'
};

/** 'local': the rough check on this computer (needs ffmpeg, sends nothing); otherwise an AI provider. */
export type VisionMethod = 'local' | AiProviderId;

export interface VisionSettings {
	/** Automatic checks while printing (off by default). "Check now" works either way. */
	enabled: boolean;
	method: VisionMethod;
	/** Check every N layers; null = not by layers. */
	everyLayers: number | null;
	/** Check every M minutes; null = not by time. */
	everyMinutes: number | null;
	/** Alert when a problem verdict is at least this sure (0.5–0.99). */
	threshold: number;
	/** Pause the print when the check is at least `threshold` sure (off by default). */
	autoPause: boolean;
	/** Printers with automatic checks switched off (by id); missing = on. */
	printers: Record<string, boolean>;
}

export const VISION_SETTINGS_DEFAULTS: VisionSettings = {
	enabled: false,
	method: 'local',
	everyLayers: 20,
	everyMinutes: 10,
	threshold: 0.75,
	autoPause: false,
	printers: {}
};

export interface VisionCheck {
	id: string;
	printerId: string;
	jobId: string | null;
	task: string;
	layer: number | null;
	totalLayers: number | null;
	at: string;
	verdict: VisionVerdict;
	/** 0–1. */
	confidence: number;
	reason: string;
	/** 'local' or the AI provider's id. */
	provider: VisionMethod;
	/** The picture is still kept (pictures go after 14 days). */
	hasFrame: boolean;
	alerted: boolean;
	paused: boolean;
	/** Why the check could not run (no picture, provider failed); verdict is then 'unsure'. */
	error: string | null;
}

export interface VisionOverview {
	printerId: string;
	/** Automatic checks on for this printer (the global switch and the printer's own). */
	active: boolean;
	/** The printer's own switch. */
	printerOn: boolean;
	settings: VisionSettings;
	methodLabel: string;
	/** A check is running now. */
	running: boolean;
	/** The camera package is present and can reach this printer's camera. */
	camera: boolean;
	recent: VisionCheck[];
}

export interface VisionSettingsView {
	settings: VisionSettings;
	/** `ready`: ffmpeg is there, or the AI provider looks set up (nothing is asked to find out). */
	methods: { id: VisionMethod; label: string; ready: boolean }[];
	/** ffmpeg was found (the rough check needs it). */
	ffmpeg: boolean;
	/** The camera package is running. */
	camera: boolean;
}

export const methodLabel = (m: VisionMethod, labels: Record<string, string>) =>
	m === 'local' ? 'Rough check on this computer' : (labels[m] ?? m);

/** "Spaghetti, 86% sure". */
export function verdictText(c: Pick<VisionCheck, 'verdict' | 'confidence' | 'error'>): string {
	if (c.error) return 'Could not check';
	return `${VERDICT_LABEL[c.verdict]}, ${Math.round(c.confidence * 100)}% sure`;
}
