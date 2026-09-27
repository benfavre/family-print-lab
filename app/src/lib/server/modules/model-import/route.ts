// The module's service for its routes (503 when the module is off).
import type { Runtime } from '$lib/server/runtime';
import { AppError } from '$lib/server/validation';

export function importsOf(rt: Runtime) {
	const m = rt.module('model-import');
	if (!m) throw new AppError(503, 'Model import is switched off.');
	return m;
}
