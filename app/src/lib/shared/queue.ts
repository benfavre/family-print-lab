// The print queue as the browser and the server both see it: items, each printer's queue switches,
// quiet hours and the timeline estimate. Times are the app computer's local time.
import { sameModel, type ModelCode } from './printers/models';

export type QueueStatus = 'waiting' | 'held' | 'dispatching' | 'sent' | 'failed';

export interface QueueItem {
	id: string;
	jobId: string;
	/** Null: any printer the file was sliced for. */
	printerId: string | null;
	position: number;
	notBefore: string | null;
	requirePlateClear: boolean;
	status: QueueStatus;
	/** Why it is held (null when the person held it) or why it failed. */
	reason: string | null;
	createdAt: string;
	updatedAt: string;
}

/** One weekday's quiet hours; an end at or before the start runs past midnight into the next day. */
export interface QuietWindow {
	on: boolean;
	/** "HH:MM". */
	start: string;
	end: string;
}

export interface QueueSettings {
	/** Seven windows, by Date.getDay() (0 is Sunday). No print starts by itself inside one. */
	quietHours: QuietWindow[];
	/** New queue items wait for someone to confirm the plate is clear. */
	requirePlateClear: boolean;
}

export const WEEKDAYS = [
	'Sunday',
	'Monday',
	'Tuesday',
	'Wednesday',
	'Thursday',
	'Friday',
	'Saturday'
] as const;

export function defaultQueueSettings(): QueueSettings {
	return {
		quietHours: WEEKDAYS.map(() => ({ on: false, start: '21:00', end: '07:00' })),
		requirePlateClear: true
	};
}

/** A queue item with what the page shows about it. */
export interface QueueItemView extends QueueItem {
	title: string;
	/** Estimated minutes of the plate it prints. */
	minutes: number | null;
	/** The printer model the file was sliced for. */
	slicedFor: string | null;
	/** Why a waiting item has not started yet, in plain words (null: it goes next). */
	waitingFor: string | null;
}

export interface QueuePrinterView {
	printerId: string;
	name: string;
	model: ModelCode;
	autoDispatch: boolean;
	plateClearNeeded: boolean;
	paused: boolean;
	/** Why this printer will not start a queued job right now (null: it would). */
	blocked: string | null;
	/** Estimated end of its current print (ISO), for the timeline. */
	busyUntil: string | null;
}

export interface QueueView {
	items: QueueItemView[];
	printers: QueuePrinterView[];
	settings: QueueSettings;
	quietNow: boolean;
}

// ---------- Quiet hours ----------

const minutes = (hhmm: string) => {
	const [h, m] = hhmm.split(':').map(Number);
	return h * 60 + m;
};

/** The quiet span that begins on the day `offset` days from `at` (local), if that day has one. */
function spanOn(
	at: Date,
	offset: number,
	windows: QuietWindow[]
): { start: Date; end: Date } | null {
	const day = new Date(at.getFullYear(), at.getMonth(), at.getDate() + offset);
	const w = windows[day.getDay()];
	if (!w?.on) return null;
	const s = minutes(w.start),
		e = minutes(w.end);
	if (s === e) return null;
	const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, s);
	const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + (e < s ? 1 : 0), 0, e);
	return { start, end };
}

export function inQuietHours(at: Date, windows: QuietWindow[]): boolean {
	return [-1, 0].some((o) => {
		const span = spanOn(at, o, windows);
		return !!span && at >= span.start && at < span.end;
	});
}

/** `at`, or the end of the quiet hours it falls in (following back-to-back windows). */
export function quietUntil(at: Date, windows: QuietWindow[]): Date {
	let t = at;
	for (let i = 0; i < 16; i++) {
		const span = [-1, 0]
			.map((o) => spanOn(t, o, windows))
			.find((s) => !!s && t >= s.start && t < s.end);
		if (!span) return t;
		t = span.end;
	}
	return t;
}

/** Quiet spans overlapping [from, to), clipped to it, in order. */
export function quietSpans(
	from: Date,
	to: Date,
	windows: QuietWindow[]
): { start: Date; end: Date }[] {
	const out: { start: Date; end: Date }[] = [];
	const days = Math.ceil((to.getTime() - from.getTime()) / 86_400_000) + 1;
	for (let o = -1; o <= days; o++) {
		const span = spanOn(from, o, windows);
		if (!span || span.end <= from || span.start >= to) continue;
		out.push({ start: span.start < from ? from : span.start, end: span.end > to ? to : span.end });
	}
	return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

// ---------- Timeline estimate ----------

export interface TimelinePrinter {
	id: string;
	model: string;
	/** Estimated end of the current print (ms), null when idle. */
	busyUntil: number | null;
}
export interface TimelineItem {
	id: string;
	printerId: string | null;
	minutes: number | null;
	notBefore: number | null;
	slicedFor: string | null;
}
export interface TimelineBlock {
	/** Null for the print running now. */
	itemId: string | null;
	printerId: string;
	start: number;
	end: number;
	/** No time estimate in the file: an hour is assumed. */
	guessed: boolean;
}

/** Assumed length of a print without an estimate. */
const UNKNOWN_MINUTES = 60;

/**
 * Where each queued item would print and when, if everything went to plan: each printer's own items
 * in order after its current print, then "any printer" items on whichever fitting printer is free
 * first. Starts are pushed past `notBefore` and quiet hours. Waiting for someone to clear the plate is
 * not modelled. Items no printer fits are left out (`unplaced`).
 */
export function planTimeline(o: {
	now: number;
	printers: TimelinePrinter[];
	items: TimelineItem[];
	quiet: QuietWindow[];
}): { blocks: TimelineBlock[]; unplaced: string[] } {
	const blocks: TimelineBlock[] = [];
	const unplaced: string[] = [];
	const free = new Map<string, number>();
	for (const p of o.printers) {
		const until = p.busyUntil && p.busyUntil > o.now ? p.busyUntil : null;
		if (until)
			blocks.push({ itemId: null, printerId: p.id, start: o.now, end: until, guessed: false });
		free.set(p.id, until ?? o.now);
	}
	const startAt = (from: number, item: TimelineItem) =>
		quietUntil(new Date(Math.max(from, item.notBefore ?? 0)), o.quiet).getTime();
	const place = (item: TimelineItem, printerId: string, start: number) => {
		const guessed = !(item.minutes && item.minutes > 0);
		const end = start + (guessed ? UNKNOWN_MINUTES : item.minutes!) * 60_000;
		blocks.push({ itemId: item.id, printerId, start, end, guessed });
		free.set(printerId, end);
	};
	for (const item of o.items.filter((i) => i.printerId)) {
		if (!free.has(item.printerId!)) unplaced.push(item.id);
		else place(item, item.printerId!, startAt(free.get(item.printerId!)!, item));
	}
	for (const item of o.items.filter((i) => !i.printerId)) {
		const fits = o.printers.filter((p) => !item.slicedFor || sameModel(item.slicedFor, p.model));
		const best = fits
			.map((p) => ({ id: p.id, start: startAt(free.get(p.id)!, item) }))
			.sort((a, b) => a.start - b.start)[0];
		if (!best) unplaced.push(item.id);
		else place(item, best.id, best.start);
	}
	return { blocks, unplaced };
}
