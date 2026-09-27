// Badge rules: which badges a child's print history earns, and the print that earned each. Pure; the
// service builds the history from finished jobs (kids/service.ts).
import type { BadgeId } from '$lib/shared/kids';
import { weekKey } from './windows';

/** One successful print, oldest first. */
export interface PrintedThing {
	jobId: string;
	/** ISO time it finished. */
	at: string;
	/** Distinct filament colours in the print (lowercase hex). */
	colours: string[];
	/** Designed from scratch in the workbench (not a kid template, an import or an AI design). */
	fromScratch: boolean;
}

export interface Earned {
	badge: BadgeId;
	jobId: string;
	at: string;
}

const COUNTS: [number, BadgeId][] = [
	[1, 'first-print'],
	[5, 'prints-5'],
	[10, 'prints-10'],
	[25, 'prints-25']
];

/** Consecutive weeks with a print needed for the streak badge. */
export const STREAK_WEEKS = 3;

/** Every badge the history earns, each with the first print that earned it. */
export function earnedBadges(history: PrintedThing[], tz: string): Earned[] {
	const out = new Map<BadgeId, Earned>();
	const earn = (badge: BadgeId, p: PrintedThing) => {
		if (!out.has(badge)) out.set(badge, { badge, jobId: p.jobId, at: p.at });
	};
	const sorted = [...history].sort((a, b) => a.at.localeCompare(b.at));
	const colours = new Set<string>();
	const weeks = new Set<string>();
	sorted.forEach((p, i) => {
		for (const [n, badge] of COUNTS) if (i + 1 === n) earn(badge, p);
		if (new Set(p.colours).size > 1) earn('multi-colour', p);
		if (p.fromScratch) earn('from-scratch', p);
		for (const c of p.colours) colours.add(c);
		if (colours.size >= 3) earn('rainbow', p);
		const week = weekKey(new Date(p.at), tz);
		weeks.add(week);
		if (streakEnding(weeks, week) >= STREAK_WEEKS) earn('week-streak', p);
	});
	return [...out.values()];
}

/** How many weeks in a row, ending with `week` (a Monday, YYYY-MM-DD), have a print. */
function streakEnding(weeks: Set<string>, week: string) {
	let n = 0;
	const day = new Date(`${week}T00:00:00Z`);
	while (weeks.has(day.toISOString().slice(0, 10))) {
		n++;
		day.setUTCDate(day.getUTCDate() - 7);
	}
	return n;
}
