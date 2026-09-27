// Shared bits of the kids module's routes (routes/api/kids).
import type { Runtime } from '../../runtime';
import { AppError } from '../../validation';

/** The kids service, or a 503 when the module did not start. */
export function needKids(rt: Runtime) {
	const kids = rt.module('kids');
	if (!kids) throw new AppError(503, 'Family features are not running. See the server log.');
	return kids;
}
