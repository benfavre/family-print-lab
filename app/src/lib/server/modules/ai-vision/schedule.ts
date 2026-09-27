// When to check and what to do with the answer (pure, so the rules are tested without a printer).
import { VISION_PROBLEMS, type VisionSettings, type VisionVerdict } from '$lib/shared/vision';

/** One printer's print, as the scheduler follows it. */
export interface PrintWatch {
	/** The print's name; a new name is a new print. */
	task: string;
	/** Layer and time of the last check (attempted, even when it failed). */
	lastLayer: number | null;
	lastAt: number | null;
	/** The first-layer picture was taken (the rough check compares with it). */
	hasReference: boolean;
	/** When the last alert went out for this print. */
	alertedAt: number | null;
	/** When we first saw this print running. */
	startedAt: number;
}

export function newWatch(task: string, now: number): PrintWatch {
	return {
		task,
		lastLayer: null,
		lastAt: null,
		hasReference: false,
		alertedAt: null,
		startedAt: now
	};
}

/** Automatic checks are on for this printer. */
export function activeFor(s: VisionSettings, printerId: string): boolean {
	return s.enabled && s.printers[printerId] !== false;
}

/**
 * Whether a print needs a check now. The first check comes once the first layer is done (layer 2,
 * the rough check's reference); then every `everyLayers` layers and/or every `everyMinutes`
 * minutes, whichever comes first.
 */
export function checkDue(
	w: PrintWatch,
	s: Pick<VisionSettings, 'everyLayers' | 'everyMinutes'>,
	layer: number | null,
	now: number
): boolean {
	if (w.lastAt === null)
		return !w.hasReference && layer !== null ? layer >= 2 : minutesDue(w, s, now);
	if (
		s.everyLayers &&
		layer !== null &&
		w.lastLayer !== null &&
		layer - w.lastLayer >= s.everyLayers
	)
		return true;
	return minutesDue(w, s, now);
}

function minutesDue(w: PrintWatch, s: Pick<VisionSettings, 'everyMinutes'>, now: number) {
	if (!s.everyMinutes) return false;
	return now - (w.lastAt ?? w.startedAt) >= s.everyMinutes * 60_000;
}

/** How long after an alert the same print may alert again (it keeps being checked meanwhile). */
export const REALERT_MS = 15 * 60_000;

export interface Decision {
	alert: boolean;
	pause: boolean;
}

/**
 * An alert when a problem verdict is sure enough (not again within 15 min for the same print, unless
 * it pauses the print: that is always worth telling); a pause when asked for.
 */
export function decide(
	r: { verdict: VisionVerdict; confidence: number; error?: string | null },
	s: Pick<VisionSettings, 'threshold' | 'autoPause'>,
	w: Pick<PrintWatch, 'alertedAt'> | null,
	now: number
): Decision {
	const problem = !r.error && VISION_PROBLEMS.includes(r.verdict) && r.confidence >= s.threshold;
	if (!problem) return { alert: false, pause: false };
	const recent = w?.alertedAt != null && now - w.alertedAt < REALERT_MS;
	return { alert: !recent || s.autoPause, pause: s.autoPause };
}
