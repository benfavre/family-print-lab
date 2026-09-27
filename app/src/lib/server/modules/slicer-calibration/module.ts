// slicer-calibration: calibration tests made by Print Lab Slicer (OrcaSlicer's generators, ported
// into the engine) printed through the queue, with the winning value saved into a user filament
// preset and the spool; plus the printer's own flow dynamics and flow rate calibration and its
// K-value profiles. Needs slicer-engine (the engine) and slicer-profiles (the presets); the queue when
// present.
import { defineModule } from '../../modules';
import type { ProfileServiceModule, QueueService, SlicerServiceModule } from '../contracts';
import type { SlicerProfilesService } from '../slicer-profiles/module';
import { openSlicer } from '../../slicer/engine';
import { Calibration } from './service';
import { calibSettings } from './validation';

declare module '../../modules' {
	interface ModuleServices {
		'slicer-calibration': Calibration;
	}
}

export default defineModule({
	key: 'slicer-calibration',
	order: 130,
	start(ctx) {
		const module = ctx.module as (key: string) => unknown;
		const calibration = new Calibration({
			db: ctx.db,
			lab: ctx.lab,
			printers: ctx.printers,
			tasks: ctx.tasks,
			printing: ctx.printing,
			settings: ctx.settings(calibSettings, { projectId: null }),
			// The slicer-engine module's shared engine when it runs, else the same lookup it would do.
			openSlicer: async () =>
				(await (module('slicer-engine') as SlicerServiceModule | undefined)?.open()) ??
				openSlicer(ctx.env),
			profiles: () =>
				module('slicer-profiles') as (SlicerProfilesService & ProfileServiceModule) | undefined,
			queue: () => module('queue') as QueueService | undefined,
			changed: () => ctx.live.send('slicer-calibration:runs', {}),
			workDir: ctx.dataDir
		});
		calibration.recover();
		return calibration;
	}
});
