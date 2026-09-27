// slicer-3mf: Bambu Studio project files. Keeps slicer projects (.3mf) per project with their meshes
// stored once by content, and offers them to other packages as ProjectStoreService (load/save the
// Project model); the routes under /api/slicer-projects use the same store.
import path from 'node:path';
import { defineModule } from '../../modules';
import { ProjectStore } from '../../slicer3mf/store';
import { AppError } from '../../validation';
import type { Runtime } from '../../runtime';

declare module '../../modules' {
	interface ModuleServices {
		'slicer-3mf': ProjectStore;
	}
}

export default defineModule({
	key: 'slicer-3mf',
	order: 60,
	start(ctx) {
		const store = new ProjectStore(ctx.db, ctx.lab, ctx.models, ctx.dataDir);
		try {
			store.sweep();
		} catch (error) {
			ctx.log(`Could not tidy ${path.basename(ctx.dataDir)}: ${(error as Error).message}`);
		}
		return store;
	}
});

/** The store, or a plain error when the module is off. */
export function projectStore(rt: Pick<Runtime, 'module'>): ProjectStore {
	const store = rt.module('slicer-3mf');
	if (!store) throw new AppError(503, 'Slicer projects are not available right now.');
	return store;
}
