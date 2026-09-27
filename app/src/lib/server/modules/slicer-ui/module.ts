// slicer-ui: the slicer workspace (/projects/[id]/slicer/[slicerProjectId]). The page edits a slicer
// project (slicer-3mf) in the browser; this module runs the engine for it (slicer-engine) with the
// presets of slicer-profiles, keeps sliced plates for preview and sends them through the print queue
// when it runs. Every one of those packages may be missing: the API then says what is not available.
import path from 'node:path';
import { defineModule } from '../../modules';
import { AppError } from '../../validation';
import type { Runtime } from '../../runtime';
import type { ProfileServiceModule, QueueService, SlicerServiceModule } from '../contracts';
import type { ProjectStore } from '../../slicer3mf/store';
import { Workspace } from './workspace';

declare module '../../modules' {
	interface ModuleServices {
		'slicer-ui': Workspace;
	}
}

export default defineModule({
	key: 'slicer-ui',
	// After slicer-3mf, slicer-engine, slicer-profiles and queue, whose services it uses.
	order: 90,
	start(ctx) {
		// Looked up on use: each of these packages is optional.
		const module = ctx.module as (key: string) => unknown;
		const workspace = new Workspace({
			lab: ctx.lab,
			printing: ctx.printing,
			tasks: ctx.tasks,
			live: ctx.live,
			dir: path.join(ctx.dataDir, 'plates'),
			store: () => module('slicer-3mf') as ProjectStore | undefined,
			engine: async () =>
				(await (module('slicer-engine') as SlicerServiceModule | undefined)?.open()) ?? null,
			profiles: () => (module('slicer-profiles') as ProfileServiceModule | undefined)?.profiles,
			queue: () => module('queue') as QueueService | undefined
		});
		try {
			workspace.sweep();
		} catch (error) {
			ctx.log(`Could not tidy the sliced plates: ${(error as Error).message}`);
		}
		return workspace;
	}
});

/** The workspace service, or a plain error when the module is off. */
export function workspaceOf(rt: Pick<Runtime, 'module'>): Workspace {
	const w = rt.module('slicer-ui');
	if (!w) throw new AppError(503, 'The slicer is not available right now.');
	return w;
}
