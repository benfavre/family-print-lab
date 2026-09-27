// gcode-preview: toolpath previews of sliced plates (GET /api/jobs/[id]/sliced/preview). The work is in
// server/gcode/; this module only wires the store to the app's sliced files and background tasks.
import { defineModule } from '../../modules';
import { PreviewStore, type PreviewAnswer } from '../../gcode/store';
import type { Job } from '$lib/shared/domain';

export interface GcodePreviewService {
	/** The job's plate as a preview container, or the task making it (large plates). */
	get(job: Job, plate: number): Promise<PreviewAnswer>;
}

declare module '../../modules' {
	interface ModuleServices {
		'gcode-preview': GcodePreviewService;
	}
}

export default defineModule({
	key: 'gcode-preview',
	start(ctx): GcodePreviewService {
		const store = new PreviewStore(ctx.printing, ctx.tasks, {
			largeBytes: Number(ctx.env.GCODE_PREVIEW_LARGE_BYTES) || undefined
		});
		return { get: (job, plate) => store.get(job, plate) };
	}
});
