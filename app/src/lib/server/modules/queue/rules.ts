// The queue's decisions, as one pure function over plain facts: which item each free printer starts
// next, which items to hold (with the reason) and which to drop. The service gathers the facts and
// carries the decision out.
//
// A printer takes a queued job when it is connected (or something can wake it: a beforeDispatch hook),
// not printing or being sent a file, has Developer Mode on, its queue is not paused and starts jobs by
// itself (or the person pressed Start next), and it is outside quiet hours (Start next ignores those).
// It looks at its own column first, then "any printer". The first item that may start goes, if the
// plate was confirmed clear (when the item asks for that), the file was sliced for this model and the
// loaded filament fits (autoMapping without problems, as the send panel suggests it).
import { autoMapping, mappingProblems, type LoadedSlot } from '$lib/shared/printing';
import {
	nozzleProblems,
	type NozzleReport,
	type NozzleRequirements
} from '$lib/shared/nozzle-compatibility';
import type { JobStatus } from '$lib/shared/domain';
import { PRINTER_MODELS, modelShort, sameModel, type ModelCode } from '$lib/shared/printers/models';
import { inQuietHours, type QueueStatus, type QuietWindow } from '$lib/shared/queue';

export interface PrinterFacts {
	id: string;
	name: string;
	model: ModelCode;
	connected: boolean;
	/** The printer has reported its state at least once. */
	reported: boolean;
	/** Printing, preparing or paused. */
	busy: boolean;
	developerModeOff: boolean;
	/** A file is being sent to it (by the queue or by hand). */
	sending: boolean;
	/** Loaded trays as last reported; null when never reported. */
	slots: LoadedSlot[] | null;
	nozzles?: NozzleReport[];
	autoDispatch: boolean;
	paused: boolean;
	plateClearNeeded: boolean;
}

export interface ItemFacts {
	id: string;
	printerId: string | null;
	status: QueueStatus;
	notBefore: string | null;
	requirePlateClear: boolean;
	reason: string | null;
	job: {
		status: JobStatus;
		/** The plate it prints: what it was sliced for and its filaments. */
		sliced: ({ printerModelId: string | null } & NozzleRequirements) | null;
	} | null;
}

export interface Dispatch {
	itemId: string;
	printerId: string;
	useAms: boolean;
	amsMapping: number[];
}

export interface Decision {
	dispatch: Dispatch[];
	/** Items to hold, only when newly held or the reason changed. */
	hold: { itemId: string; reason: string }[];
	/** Items whose job moved on without the queue (sent by hand, cancelled, finished). */
	drop: string[];
	/** Why each item that stays waiting has not started, in plain words. */
	waiting: Record<string, string | null>;
	/** Why each printer will not start a queued job (null: it would). */
	blocked: Record<string, string | null>;
}

export const PLATE_MESSAGE = 'Waiting for someone to clear the plate.';

/** "a P1S", "an X2D". */
const withArticle = (name: string) => `${/^[AEFHILMNORSX]/i.test(name) ? 'an' : 'a'} ${name}`;

/** "14:30", or "Tue 14:30" when not today. */
export function timeLabel(at: Date, now: Date): string {
	const hm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
	return at.toDateString() === now.toDateString()
		? hm
		: `${at.toLocaleDateString('en-GB', { weekday: 'short' })} ${hm}`;
}

export function printerBlock(
	p: PrinterFacts,
	o: { quiet: boolean; canWake: boolean; manual: boolean }
): string | null {
	if (p.paused) return 'The queue is paused for this printer.';
	if (!p.autoDispatch && !o.manual) return 'Starts queued jobs only when you press Start next.';
	if (!p.connected) {
		if (!o.canWake) return 'The printer is not connected.';
		// Waking it is possible, but the filament to match is unknown until it has reported once.
		if (!p.slots) return 'Waiting for the printer to report once.';
	} else if (!p.reported) return 'Waiting for the printer to report.';
	if (p.busy) return 'Printing.';
	if (p.sending) return 'A print is being sent to it.';
	if (p.developerModeOff) return 'Needs Developer Mode on the printer.';
	if (o.quiet && !o.manual) return 'Quiet hours.';
	return null;
}

export function decide(
	printers: PrinterFacts[],
	items: ItemFacts[],
	o: {
		now: Date;
		quiet: QuietWindow[];
		canWake: boolean;
		/** A printer whose Start next was pressed: ignores its auto switch and quiet hours. */
		manual?: string;
	}
): Decision {
	const d: Decision = { dispatch: [], hold: [], drop: [], waiting: {}, blocked: {} };
	const quiet = inQuietHours(o.now, o.quiet);
	const hold = (item: ItemFacts, reason: string) => {
		if (item.status !== 'held' || item.reason !== reason) d.hold.push({ itemId: item.id, reason });
		d.waiting[item.id] = reason;
	};
	const known = new Map(printers.map((p) => [p.id, p]));

	// Item-level checks first; what survives is a candidate.
	const candidates: ItemFacts[] = [];
	for (const item of items) {
		const job = item.job;
		if (item.status === 'dispatching') continue;
		if (item.status === 'sent') {
			if (job?.status !== 'Printing') d.drop.push(item.id);
			continue;
		}
		if (!job || job.status !== 'Queued') {
			d.drop.push(item.id);
			continue;
		}
		if (item.status === 'failed') {
			d.waiting[item.id] = item.reason;
			continue;
		}
		// A hold the person chose stays until they release it; automatic holds are looked at again.
		if (item.status === 'held' && item.reason === null) {
			d.waiting[item.id] = 'On hold.';
			continue;
		}
		if (!job.sliced) {
			hold(item, 'Attach a sliced file first.');
			continue;
		}
		const model = job.sliced.printerModelId;
		if (item.printerId) {
			const p = known.get(item.printerId);
			if (!p) {
				d.waiting[item.id] = 'That printer is switched off in Integrations → Printers.';
				continue;
			}
			if (model && !sameModel(model, p.model)) {
				hold(
					item,
					`This file was sliced for the ${modelShort(model)}. ${p.name} is ${withArticle(PRINTER_MODELS[p.model].short)}.`
				);
				continue;
			}
		} else if (model && !printers.some((p) => sameModel(model, p.model))) {
			hold(item, `No printer here takes files sliced for the ${modelShort(model)}.`);
			continue;
		}
		if (item.notBefore && Date.parse(item.notBefore) > o.now.getTime()) {
			d.waiting[item.id] = `Starts after ${timeLabel(new Date(item.notBefore), o.now)}.`;
			continue;
		}
		candidates.push(item);
	}

	const taken = new Set<string>();
	/** "Any printer" items a free printer turned down for its nozzle or filament: held if nothing takes them. */
	const amsMiss = new Map<string, string>();
	for (const p of printers) {
		const block = printerBlock(p, { quiet, canWake: o.canWake, manual: o.manual === p.id });
		d.blocked[p.id] = block;
		if (block) continue;
		const mine = candidates.filter((i) => i.printerId === p.id);
		const any = candidates.filter(
			(i) =>
				!i.printerId &&
				!taken.has(i.id) &&
				(!i.job!.sliced!.printerModelId || sameModel(i.job!.sliced!.printerModelId, p.model))
		);
		for (const item of [...mine, ...any]) {
			if (item.requirePlateClear && p.plateClearNeeded) {
				d.blocked[p.id] = PLATE_MESSAGE;
				break;
			}
			const slots = p.slots ?? [];
			const filaments = item.job!.sliced!.filaments;
			const useAms = slots.length > 0;
			const amsMapping = useAms ? autoMapping(filaments, slots) : [];
			const problems = [
				...nozzleProblems(item.job!.sliced!, p.nozzles, PRINTER_MODELS[p.model].nozzles),
				...(useAms ? mappingProblems(filaments, amsMapping, slots) : [])
			];
			if (problems.length) {
				if (item.printerId) hold(item, problems.join(' '));
				else amsMiss.set(item.id, `${p.name}: ${problems.join(' ')}`);
				continue;
			}
			taken.add(item.id);
			amsMiss.delete(item.id);
			d.dispatch.push({ itemId: item.id, printerId: p.id, useAms, amsMapping });
			break;
		}
	}
	for (const [id, reason] of amsMiss)
		hold(
			candidates.find((i) => i.id === id)!,
			reason
		);

	// Why the rest are still waiting.
	for (const item of candidates) {
		if (taken.has(item.id) || item.id in d.waiting) continue;
		if (item.printerId) d.waiting[item.id] = d.blocked[item.printerId] ?? null;
		else {
			const model = item.job!.sliced!.printerModelId;
			const fits = printers.filter((p) => !model || sameModel(model, p.model));
			const busy = new Set(d.dispatch.map((x) => x.printerId));
			const free = fits.find((p) => !d.blocked[p.id] && !busy.has(p.id));
			const only = fits.length === 1 ? d.blocked[fits[0].id] : null;
			d.waiting[item.id] = free
				? null
				: only
					? `${fits[0].name}: ${only}`
					: `Waiting for a free ${model ? modelShort(model) : 'printer'}.`;
		}
	}
	return d;
}
