// Small helpers the camera routes share.
import type { Runtime } from '$lib/server/runtime';
import { AppError } from '$lib/server/validation';
import type { CameraModule } from './module';

/** The camera module, or a 404 when it is not running. */
export function cameraOf(rt: Pick<Runtime, 'module'>): CameraModule {
	const camera = rt.module('camera');
	if (!camera) throw new AppError(404, 'Camera support is not running.');
	return camera;
}

const TYPES: [RegExp, string][] = [
	[/\.mp4$/i, 'video/mp4'],
	[/\.mov$/i, 'video/quicktime'],
	[/\.avi$/i, 'video/x-msvideo'],
	[/\.jpe?g$/i, 'image/jpeg'],
	[/\.png$/i, 'image/png']
];

export function contentTypeFor(name: string): string {
	return TYPES.find(([re]) => re.test(name))?.[1] ?? 'application/octet-stream';
}

/** attachment/inline with a plain ASCII name and the exact UTF-8 one (RFC 6266). */
export function contentDisposition(kind: 'attachment' | 'inline', name: string): string {
	const ascii = name.replace(/[^\w .()+-]/g, '_').slice(0, 150) || 'file';
	return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
