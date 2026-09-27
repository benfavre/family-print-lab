import { AppError } from '../../validation';
import type { Runtime } from '../../runtime';
import type { ControlsService } from './module';

/** The controls module's service for a route (503 while the module is off). */
export function controlsService(rt: Pick<Runtime, 'module'>): ControlsService {
	const service = rt.module('controls');
	if (!service) throw new AppError(503, 'Printer controls are not available right now.');
	return service;
}
