// Printer controls: the commands themselves are defs in printer/commands/defs/controls.ts and run
// through POST /api/printers/[id]/commands. This module adds what the command layer cannot: the print
// options the printer reports (from the raw report; pushed to open tabs on `controls:options` when they
// change) and the objects of the plate being printed, read from the job's sliced file, for skip objects.
import fs from 'node:fs';
import { defineModule } from '../../modules';
import { capabilitiesFor } from '$lib/shared/printers/models';
import { isActive, type PlateObjects, type PrintOptions } from '$lib/shared/controls';
import { parsePrintOptions } from './options';
import { readPlateObjects, type PlateContents } from './plate';

export type PlateImage = 'plate' | 'top' | 'pick';

export interface ControlsService {
	/** Print options as the printer last reported them. */
	options(printerId: string): PrintOptions;
	/** Objects on the plate being printed, with what is skipped already. */
	objects(printerId: string): PlateObjects;
	/** A picture from the job's sliced file: the plate, its top view or the top view's pick image. */
	platePicture(printerId: string, which?: PlateImage): Buffer | null;
}

declare module '../../modules' {
	interface ModuleServices {
		controls: ControlsService;
	}
}

/** Live channel with { printerId, options } whenever a printer's options change. */
export const OPTIONS_CHANNEL = 'controls:options';

export default defineModule({
	key: 'controls',
	start(ctx): ControlsService {
		const cache = new Map<string, PlateContents>();
		const sent = new Map<string, string>();
		const checked = new Map<string, number>();

		const options = (printerId: string): PrintOptions => {
			const printer = ctx.printers.require(printerId);
			return parsePrintOptions(
				printer.rawReport().pushall,
				capabilitiesFor(printer.model.code, printer.firmware)
			);
		};

		/** The plate of the sliced file the running print came from, when it was sent from here. */
		const plateOf = (printerId: string): { key: string; file: string; plate: number } | null => {
			const printer = ctx.printers.require(printerId);
			const s = printer.snapshot;
			if (!s || !isActive(s)) return null;
			const jobId = ctx.lab.jobIdForTask(printerId, s.task);
			const sliced = jobId ? ctx.lab.getJob(jobId)?.sliced : null;
			if (!sliced) return null;
			const file = ctx.printing.file(sliced.file);
			return fs.existsSync(file)
				? { key: `${sliced.file}#${sliced.plate}`, file, plate: sliced.plate }
				: null;
		};

		const contents = (printerId: string): (PlateContents & { plate: number }) | null => {
			const found = plateOf(printerId);
			if (!found) return null;
			let c = cache.get(found.key);
			if (!c) {
				c = readPlateObjects(fs.readFileSync(found.file), found.plate);
				cache.set(found.key, c);
				// A few prints at a time is plenty.
				if (cache.size > 8) cache.delete(cache.keys().next().value!);
			}
			return { ...c, plate: found.plate };
		};

		// Push option changes to open tabs, at most every two seconds per printer.
		const onUpdate = (printerId: string) => {
			const now = Date.now();
			if (now - (checked.get(printerId) ?? 0) < 2000) return;
			checked.set(printerId, now);
			try {
				const printer = ctx.printers.get(printerId);
				if (!printer?.snapshot) return;
				const next = options(printerId);
				const json = JSON.stringify(next);
				if (sent.get(printerId) === json) return;
				sent.set(printerId, json);
				ctx.live.send(OPTIONS_CHANNEL, { printerId, options: next });
			} catch (error) {
				ctx.log(`Print options not read: ${(error as Error).message}`);
			}
		};
		// The listener goes with the printer manager when the runtime closes.
		ctx.printers.on('update', onUpdate);

		return {
			options,
			objects(printerId) {
				const s = ctx.printers.require(printerId).snapshot;
				const skipped = s?.skippedObjects ?? [];
				const c = contents(printerId);
				if (!c)
					return {
						source: 'report',
						plate: null,
						objects: [],
						bboxAll: null,
						picture: false,
						pickMap: false,
						skipped
					};
				return {
					source: 'file',
					plate: c.plate,
					objects: c.objects.map((o) => ({ ...o, skipped: o.skipped || skipped.includes(o.id) })),
					bboxAll: c.bboxAll,
					picture: !!c.picture,
					pickMap: !!c.pick,
					skipped
				};
			},
			platePicture(printerId, which = 'plate') {
				const c = contents(printerId);
				return (which === 'top' ? c?.top : which === 'pick' ? c?.pick : c?.picture) ?? null;
			}
		};
	}
});
