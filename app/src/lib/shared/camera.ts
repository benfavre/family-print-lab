// The camera package's types, shared by the server module, the API and the UI.

/** How the app reaches a printer's live camera right now. */
export type CameraPath = 'rtsps' | 'rtsp' | 'jpeg';

/** Why there is no live image. */
export type CameraOffReason =
	'switched-off' | 'offline' | 'no-camera' | 'liveview-off' | 'ffmpeg-missing' | 'error';

export interface CameraState {
	printerId: string;
	/** A live image can be asked for (the stream may still be starting). */
	available: boolean;
	path: CameraPath | null;
	/** Set when not available, or when the running stream failed. */
	reason: CameraOffReason | null;
	/** Plain words for the person: what is wrong and what to do. */
	message: string;
	/** A stream is running and frames are arriving. */
	live: boolean;
	/** When the newest frame arrived (ISO), if a stream ran. */
	lastFrameAt: string | null;
	/** Simulated printers serve generated frames over the port-6000 path. */
	simulated: boolean;
}

export interface CameraSettings {
	/** Small live pictures on the printer cards (a snapshot every 10 s). */
	showOnCards: boolean;
}

export const CAMERA_SETTINGS_DEFAULTS: CameraSettings = { showOnCards: false };

/** A file or folder on the printer's storage. */
export interface MediaEntry {
	name: string;
	/** Absolute path on the printer ("/timelapse/video.mp4"). */
	path: string;
	type: 'file' | 'dir';
	size: number | null;
	modified: string | null;
	kind: 'video' | 'image' | 'print' | 'other' | 'dir';
	/** Path of a thumbnail image found next to it, if any. */
	thumbnail: string | null;
}

export interface MediaListing {
	dir: string;
	entries: MediaEntry[];
	/** A plain-words note when the folder is empty or missing (e.g. timelapses kept on internal storage). */
	note: string | null;
}

export const TIMELAPSE_DIR = '/timelapse';

const VIDEO = /\.(mp4|avi|mov)$/i;
const IMAGE = /\.(jpe?g|png)$/i;
const PRINT = /\.(gcode\.3mf|3mf|gcode)$/i;

export function mediaKind(name: string, type: 'file' | 'dir'): MediaEntry['kind'] {
	if (type === 'dir') return 'dir';
	if (VIDEO.test(name)) return 'video';
	if (IMAGE.test(name)) return 'image';
	if (PRINT.test(name)) return 'print';
	return 'other';
}
