// The maintenance service for the API routes, or a plain 503 when the module is off.
import type { Runtime } from '$lib/server/runtime';
import { AppError } from '$lib/server/validation';

export function maintenanceOf(rt: Runtime) {
	const service = rt.module('maintenance');
	if (!service) throw new AppError(503, 'The maintenance tracker is not running.');
	return service;
}
