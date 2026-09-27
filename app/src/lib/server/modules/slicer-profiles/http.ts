// Route helpers for the slicer profile API.
import { AppError } from '../../validation';
import type { Runtime } from '../../runtime';
import type { PresetRef } from '$lib/shared/slicer/project';

/** The module's service, or a 503 when the module is off. */
export function profilesOf(rt: Runtime) {
	const s = rt.module('slicer-profiles');
	if (!s) throw new AppError(503, 'Slicer profiles are switched off.');
	return s.lab;
}

/** A preset reference from query parameters: kind, name, source (default system), id (user presets). */
export function refFromQuery(q: URLSearchParams): PresetRef {
	const id = q.get('id');
	return {
		kind: (q.get('kind') ?? '') as PresetRef['kind'],
		name: q.get('name') ?? (id ? 'user' : ''),
		source: (q.get('source') ?? (id ? 'user' : 'system')) as PresetRef['source'],
		...(id ? { userPresetId: id } : {})
	};
}
