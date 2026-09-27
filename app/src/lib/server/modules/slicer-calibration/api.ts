// The calibration service for API routes (a 503 when the module is off or failed to start).
import type { Runtime } from '../../runtime';
import { AppError } from '../../validation';
import type { Calibration } from './service';

export function calibrationOf(rt: Runtime): Calibration {
	const c = rt.module('slicer-calibration');
	if (!c) throw new AppError(503, 'Calibration is not running.');
	return c;
}
