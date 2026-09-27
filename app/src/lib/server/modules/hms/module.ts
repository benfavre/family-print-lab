// hms: understandable printer errors. Looks HMS alerts and print errors up in the offline database
// (resources/hms), keeps their history in hms_events (raised and cleared, with the job they happened
// during) and runs the buttons Bambu defines for them. Others use describe() (notifications).
import { defineModule } from '$lib/server/modules';
import { hmsKeyOf, printErrorKey, type HmsKind } from '$lib/shared/hms';
import { loadHmsDatabase } from './database';
import { createHmsService, type HmsModuleService } from './service';
import { hmsSettingsSchema } from './validation';

declare module '$lib/server/modules' {
	interface ModuleServices {
		hms: HmsModuleService;
	}
}

let stopListening: (() => void)[] = [];

export default defineModule({
	key: 'hms',
	order: 20,
	start(ctx) {
		const settings = ctx.settings(hmsSettingsSchema, { language: 'en' as const });
		const database = loadHmsDatabase(settings.get().language);
		if (!database)
			ctx.log('No printer error database (run bun run hms:build); codes show as numbers.');
		const service = createHmsService({
			db: ctx.db,
			lab: ctx.lab,
			printers: ctx.printers,
			database,
			onChange: (printerId) => ctx.live.send('hms:changed', { printerId })
		});
		const safely = (what: string, fn: () => void) => {
			try {
				fn();
			} catch (error) {
				ctx.log(`${what}: ${(error as Error).message}`);
			}
		};
		const jobFor = (printerId: string) => {
			const task = ctx.printers.get(printerId)?.snapshot?.task ?? '';
			return task ? ctx.lab.jobIdForTask(printerId, task) : null;
		};

		stopListening.push(
			ctx.bus.on('hms.raised', (e) =>
				safely('Alert not recorded', () =>
					service.raised(e.printerId, 'hms', hmsKeyOf(e.hms), jobFor(e.printerId))
				)
			),
			ctx.bus.on('hms.cleared', (e) =>
				safely('Alert not closed', () => service.cleared(e.printerId, 'hms', hmsKeyOf(e.hms)))
			),
			// Runs after the runtime closed the job, so jobId is set when the print was linked (4.5).
			ctx.bus.on('print.failed', (e) =>
				safely('Print error not recorded', () => {
					if (e.printError)
						service.raised(e.printerId, 'print_error', printErrorKey(e.printError), e.jobId);
				})
			)
		);

		// Print errors come and go without bus events of their own (a pause for a runout, say), and a
		// printer may have cleared alerts while the app was away: follow each printer's reports.
		const lastError = new Map<string, number>();
		const onUpdate = (printerId: string) =>
			safely('Print error not followed', () => {
				const s = ctx.printers.get(printerId)?.snapshot;
				if (!s) return;
				const first = !lastError.has(printerId);
				const before = lastError.get(printerId) ?? 0;
				lastError.set(printerId, s.printError);
				if (before === s.printError && !first) return;
				const current = service.active(printerId);
				if (first)
					service.reconcile(
						printerId,
						current.map((a) => ({ kind: a.kind as HmsKind, key: a.key }))
					);
				if (before) service.cleared(printerId, 'print_error', printErrorKey(before));
				if (current.some((a) => a.kind === 'print_error'))
					service.raised(printerId, 'print_error', printErrorKey(s.printError), jobFor(printerId));
				if (first)
					for (const a of current)
						if (a.kind === 'hms') service.raised(printerId, 'hms', a.key, jobFor(printerId));
			});
		ctx.printers.on('update', onUpdate);
		stopListening.push(() => ctx.printers.off('update', onUpdate));
		return service;
	},
	stop() {
		for (const off of stopListening) off();
		stopListening = [];
	},
	integrations() {
		const db = loadHmsDatabase('en');
		const f = db?.file;
		return [
			{
				id: 'hms',
				kind: 'module',
				name: 'Printer error help',
				via: 'Offline texts from Bambu Studio and ha-bambulab',
				available: !!f,
				version: f?.version ?? null,
				detail: f
					? `Works offline. ${Object.keys(f.hms).length.toLocaleString('en-GB')} alert codes and ${Object.keys(f.errors).length.toLocaleString('en-GB')} print errors in English and French, data version ${f.version}.`
					: 'The error database is missing, so alerts show as codes only.',
				powers: f
					? [
							'Printer alerts in plain words, with severity and a wiki link',
							'Buttons Bambu defines for an error (resume, retry, OK)',
							'Alert history per printer'
						]
					: [],
				setup: f
					? []
					: [{ text: 'Build the database from the app folder', command: 'bun run hms:build' }]
			}
		];
	}
});
