// The AI check service for the API routes, or a plain 503 when the module is off.
import type { Runtime } from '$lib/server/runtime';
import { AppError } from '$lib/server/validation';

export function visionOf(rt: Runtime) {
	const service = rt.module('ai-vision');
	if (!service) throw new AppError(503, 'AI print checks are not running.');
	return service;
}
