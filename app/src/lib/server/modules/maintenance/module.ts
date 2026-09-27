// Maintenance tracker: care tasks per printer from the Bambu Lab wiki, a print-hours odometer, the log
// of what was done, nozzle changes, and a `maintenance.due` event once per task when it falls due
// (checked hourly and after every print). Read-only firmware and hotend rack facts for the page.
import { commandDef } from '$lib/server/printer/commands/registry';
import { defineModule } from '$lib/server/modules';
import { AppError, parse } from '$lib/server/validation';
import { PRINTER_MODELS } from '$lib/shared/printers/models';
import {
	accessoryRefusal,
	type MaintenanceLogEntry,
	type MaintenanceOverview
} from '$lib/shared/maintenance';
import { RELEASE_NOTES } from './defaults';
import { parseRack } from './rack';
import { MaintenanceStore } from './store';
import { nozzleChangeInput } from './validation';

export interface MaintenanceService {
	store: MaintenanceStore;
	overview(printerId: string): MaintenanceOverview;
	/** Logs a nozzle change and, when asked and supported, tells the printer. */
	changeNozzle(printerId: string, input: unknown): Promise<MaintenanceLogEntry>;
	/** Emits maintenance.due for tasks newly due (all printers, or one); returns how many. */
	check(printerId?: string): number;
	/** Tells open pages that a printer's maintenance changed. */
	changed(printerId: string): void;
}

declare module '$lib/server/modules' {
	interface ModuleServices {
		maintenance: MaintenanceService;
	}
}

declare module '$lib/server/events' {
	interface LabEventMap {
		'maintenance.due': {
			printerId: string;
			printerName: string;
			taskId: string;
			label: string;
			kind: string;
			/** The interval that ran out. */
			by: 'hours' | 'days';
		};
	}
}

const HOUR = 60 * 60 * 1000;
let timers: ReturnType<typeof setTimeout>[] = [];
let unsubscribe: (() => void)[] = [];

export default defineModule({
	key: 'maintenance',
	order: 120,
	start(ctx): MaintenanceService {
		const store = new MaintenanceStore(ctx.db);
		const amsDone = new Set<string>();

		const seedAll = () => {
			for (const p of ctx.printers.info()) {
				try {
					store.seedDefaults(p.id, p.model);
					if (store.amsSeeded(p.id)) amsDone.add(p.id);
				} catch (error) {
					ctx.log(`Could not add the default tasks for ${p.name}: ${(error as Error).message}`);
				}
			}
		};
		seedAll();

		const changed = (printerId: string) => ctx.live.send('maintenance:changed', { printerId });

		const check = (printerId?: string) => {
			const due = store.collectDue(printerId);
			for (const d of due)
				ctx.bus.emit('maintenance.due', {
					printerId: d.task.printerId,
					printerName: d.printerName,
					taskId: d.task.id,
					label: d.task.label,
					kind: d.task.kind,
					by: d.by
				});
			for (const id of new Set(due.map((d) => d.task.printerId))) changed(id);
			return due.length;
		};

		// New printers get their tasks; a printer that reports an AMS for the first time gets the AMS ones.
		const onChanged = () => seedAll();
		const onUpdate = (id: string) => {
			if (amsDone.has(id)) return;
			const ams = ctx.printers.get(id)?.snapshot?.ams;
			if (!ams?.length) return;
			amsDone.add(id);
			try {
				if (store.seedAms(id, ams)) changed(id);
			} catch (error) {
				ctx.log(`Could not add the AMS tasks: ${(error as Error).message}`);
			}
		};
		ctx.printers.on('changed', onChanged);
		ctx.printers.on('update', onUpdate);
		unsubscribe.push(
			() => ctx.printers.off('changed', onChanged),
			() => ctx.printers.off('update', onUpdate)
		);

		// Print hours change when a print ends (the runtime has already closed the job and set its
		// actual minutes by the time these listeners run: events.ts ordering guarantee).
		for (const name of ['print.finished', 'print.failed', 'print.cancelled'] as const)
			unsubscribe.push(
				ctx.bus.on(name, (d) => {
					try {
						check(d.printerId);
						changed(d.printerId);
					} catch (error) {
						ctx.log(`Maintenance check failed: ${(error as Error).message}`);
					}
				})
			);

		// The first check waits a little so every module has subscribed; then hourly.
		const tick = () => {
			try {
				check();
			} catch (error) {
				ctx.log(`Maintenance check failed: ${(error as Error).message}`);
			}
		};
		const first = setTimeout(tick, 10_000);
		const hourly = setInterval(tick, HOUR);
		first.unref?.();
		hourly.unref?.();
		timers.push(first, hourly);

		return {
			store,
			check,
			changed,
			overview(printerId) {
				const printer = ctx.printers.get(printerId);
				if (!printer) throw new AppError(404, 'That printer is not here any more.');
				const model = PRINTER_MODELS[printer.model.code];
				return {
					printerId,
					odometer: store.odometer(printerId),
					tasks: store.tasks(printerId),
					log: store.log(printerId),
					rack:
						model.caps.hotendRack || printer.snapshot?.firmwareSupport.nozzleRack
							? parseRack(printer.rawReport().pushall)
							: null,
					releaseNotes: RELEASE_NOTES[model.code] ?? null,
					canSetNozzle:
						!!commandDef('system.set_accessories') &&
						accessoryRefusal(model, printer.snapshot?.nozzles[0]?.type) === null
				};
			},
			async changeNozzle(printerId, input) {
				const data = parse(nozzleChangeInput, input);
				if (data.send) {
					if (!data.type) throw new AppError(400, 'Choose the nozzle type to tell the printer.');
					await ctx.printers.require(printerId).send('system.set_accessories', {
						nozzleDiameter: data.diameter,
						nozzleType: data.type
					});
				}
				const entry = store.logNozzleChange(printerId, data);
				changed(printerId);
				return entry;
			}
		};
	},
	stop() {
		for (const t of timers) clearTimeout(t);
		for (const off of unsubscribe) off();
		timers = [];
		unsubscribe = [];
	}
});
