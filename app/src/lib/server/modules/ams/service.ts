// How the AMS routes reach the module (it may have failed to start: say so instead of crashing).
import type { Runtime } from '../../runtime';
import { AppError } from '../../validation';
import type { AmsService } from './module';

export function amsService(rt: Pick<Runtime, 'module'>): AmsService {
	const service = rt.module('ams');
	if (!service) throw new AppError(503, 'AMS sync is not running. Check the server log.');
	return service;
}
