// The print queue module: jobs lined up per printer or for any printer that fits, started one after
// another by the dispatcher (service.ts) with the checks in rules.ts.
import { defineModule } from '../../modules';
import type { QueueService } from '../contracts';
import { Queue } from './service';
import { queueSettings } from './validation';
import { defaultQueueSettings } from '$lib/shared/queue';

declare module '../../modules' {
	interface ModuleServices {
		queue: QueueService & Queue;
	}
}

declare module '../../events' {
	interface LabEventMap {
		/** The queue sent a job to a printer (the send task may still fail: watch the task). */
		'queue.dispatched': { itemId: string; jobId: string; printerId: string; taskId: string };
		/** An item cannot start until someone acts (filament, model, file), or the send was refused. */
		'queue.held': { itemId: string; jobId: string; printerId: string | null; reason: string };
	}
}

// stop() gets no context, so the started queues are kept here (one per runtime; tests may boot several).
const started = new Set<Queue>();

export default defineModule({
	key: 'queue',
	order: 60,
	start(ctx) {
		const queue = new Queue({
			db: ctx.db,
			lab: ctx.lab,
			bus: ctx.bus,
			printers: ctx.printers,
			printing: ctx.printing,
			tasks: ctx.tasks,
			hooks: ctx.hooks,
			live: ctx.live,
			settings: ctx.settings(queueSettings, defaultQueueSettings()),
			log: ctx.log
		}).start();
		started.add(queue);
		return queue;
	},
	stop() {
		for (const queue of started) queue.stop();
		started.clear();
	}
});
