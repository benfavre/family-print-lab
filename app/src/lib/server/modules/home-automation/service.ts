// The home-automation service for its routes (503 when the module did not start).
import type { Runtime } from '../../runtime';
import { AppError } from '../../validation';
import type { HomeAutomation } from './module';

export function homeAutomation(rt: Runtime): HomeAutomation {
	const service = rt.module('home-automation');
	if (!service) throw new AppError(503, 'Home automation is not running. Look at the app log.');
	return service;
}
