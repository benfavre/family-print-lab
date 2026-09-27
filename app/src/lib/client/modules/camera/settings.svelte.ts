// The camera settings as the browser knows them (loaded once, shared by every card and the settings
// section).
import { CAMERA_SETTINGS_DEFAULTS, type CameraSettings } from '$lib/shared/camera';

class CameraPrefs {
	value = $state<CameraSettings>({ ...CAMERA_SETTINGS_DEFAULTS });
	loaded = $state(false);
	private loading: Promise<void> | null = null;

	load(): Promise<void> {
		this.loading ??= fetch('/api/camera/settings')
			.then((r) => (r.ok ? r.json() : null))
			.then((v: CameraSettings | null) => {
				if (v) this.value = v;
				this.loaded = true;
			})
			.catch(() => {
				this.loading = null;
			});
		return this.loading;
	}
}

export const cameraPrefs = new CameraPrefs();

/** Human file sizes: 12.3 MB. */
export function fileSize(bytes: number | null): string {
	if (bytes === null) return '—';
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB'];
	let n = bytes / 1024;
	let i = 0;
	while (n >= 1024 && i < units.length - 1) {
		n /= 1024;
		i++;
	}
	return `${n >= 10 ? Math.round(n) : Math.round(n * 10) / 10} ${units[i]}`;
}

/** The download URL of a file on the printer. */
export function fileUrl(printerId: string, path: string, inline = false): string {
	return `/api/printers/${encodeURIComponent(printerId)}/files/download?path=${encodeURIComponent(path)}${inline ? '&inline=1' : ''}`;
}
