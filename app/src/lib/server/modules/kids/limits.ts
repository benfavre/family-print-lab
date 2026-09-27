// The kids' print limits: how much a child asked for in the current day, week and month, and whether
// one more request fits. Pure; the service feeds it the child's requests (kids/service.ts).
import type { KidLimits, LimitCheck, LimitReason, LimitUsage } from '$lib/shared/kids';
import { windowStart } from './windows';

/** One request that counts towards the limits (waiting, or said yes to and not failed). */
export interface CountedAsk {
	/** ISO time the child asked. */
	at: string;
	grams: number;
}

export function usageOf(asks: CountedAsk[], now: Date, tz: string): LimitUsage {
	const day = windowStart(now, 'day', tz).toISOString();
	const week = windowStart(now, 'week', tz).toISOString();
	const month = windowStart(now, 'month', tz).toISOString();
	const usage: LimitUsage = {
		printsToday: 0,
		printsThisWeek: 0,
		gramsThisWeek: 0,
		gramsThisMonth: 0
	};
	for (const a of asks) {
		if (a.at >= day) usage.printsToday++;
		if (a.at >= week) {
			usage.printsThisWeek++;
			usage.gramsThisWeek += a.grams;
		}
		if (a.at >= month) usage.gramsThisMonth += a.grams;
	}
	return usage;
}

const KID_WORDS: Record<LimitReason, string> = {
	day: 'That’s all the printing for today. Ask again tomorrow! 🌙',
	week: 'You made lots of things this week! Ask again on Monday. 🌟',
	'grams-week':
		'This one needs more filament than is left for this week. Try a smaller one, or ask again on Monday. 🧵',
	'grams-month':
		'This one needs more filament than is left for this month. Try a smaller one, or ask again next month. 🧵'
};

/** Whether one more request of `grams` fits. A limit of 0 means no prints of that kind. */
export function checkLimits(limits: KidLimits, usage: LimitUsage, grams: number): LimitCheck {
	const over = (limit: number | null, used: number, adding: number) =>
		limit !== null && used + adding > limit;
	let reason: LimitReason | null = null;
	let parentText = '';
	if (over(limits.printsPerDay, usage.printsToday, 1)) {
		reason = 'day';
		parentText = `Daily limit reached (${usage.printsToday} of ${limits.printsPerDay} today).`;
	} else if (over(limits.printsPerWeek, usage.printsThisWeek, 1)) {
		reason = 'week';
		parentText = `Weekly limit reached (${usage.printsThisWeek} of ${limits.printsPerWeek} this week).`;
	} else if (over(limits.gramsPerWeek, usage.gramsThisWeek, grams)) {
		reason = 'grams-week';
		parentText = `Over the weekly filament limit (${usage.gramsThisWeek} g used + ${grams} g of ${limits.gramsPerWeek} g).`;
	} else if (over(limits.gramsPerMonth, usage.gramsThisMonth, grams)) {
		reason = 'grams-month';
		parentText = `Over the monthly filament limit (${usage.gramsThisMonth} g used + ${grams} g of ${limits.gramsPerMonth} g).`;
	}
	return {
		ok: reason === null,
		reason,
		message: reason ? KID_WORDS[reason] : '',
		parentText,
		grams,
		usage,
		limits,
		autoApprove:
			reason === null &&
			limits.needApprovalOverGrams !== null &&
			grams <= limits.needApprovalOverGrams
	};
}

/**
 * Whether the child can ask for anything at all right now (the count limits; filament depends on
 * the thing). Returns the kind words when not.
 */
export function blockedNow(limits: KidLimits, usage: LimitUsage): string | null {
	const check = checkLimits(limits, usage, 0);
	return check.reason === 'day' || check.reason === 'week' ? check.message : null;
}
