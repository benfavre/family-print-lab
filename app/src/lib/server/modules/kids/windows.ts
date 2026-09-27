// Calendar windows for the kids' limits: today, this week (from Monday) and this month, in the
// family's time zone, as UTC instants to compare with the database's ISO timestamps. Pure.

export type Period = 'day' | 'week' | 'month';

/** This computer's time zone (IANA name), or UTC when the runtime cannot tell. */
export function localTimeZone() {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function validTimeZone(tz: string) {
	try {
		new Intl.DateTimeFormat('en-GB', { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string) {
	let f = formatters.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat('en-GB', {
			timeZone: tz,
			hourCycle: 'h23',
			year: 'numeric',
			month: 'numeric',
			day: 'numeric',
			hour: 'numeric',
			minute: 'numeric',
			second: 'numeric'
		});
		formatters.set(tz, f);
	}
	return f;
}

/** The wall-clock date and time in `tz` at an instant. */
export function wallTime(at: Date, tz: string) {
	const parts: Record<string, number> = {};
	for (const p of formatter(tz).formatToParts(at))
		if (p.type !== 'literal') parts[p.type] = Number(p.value);
	return {
		year: parts.year,
		month: parts.month,
		day: parts.day,
		hour: parts.hour,
		minute: parts.minute,
		second: parts.second
	};
}

/** How far `tz` is ahead of UTC at an instant, in milliseconds. */
function offsetAt(ms: number, tz: string) {
	const w = wallTime(new Date(ms), tz);
	const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
	return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant local midnight starts a date in `tz` (month/day may overflow; Date.UTC normalises).
 * On a day that skips midnight (a DST change at 00:00) it is the first moment of that day.
 */
export function startOfLocalDay(year: number, month: number, day: number, tz: string) {
	const guess = Date.UTC(year, month - 1, day);
	const first = guess - offsetAt(guess, tz);
	// The offset can differ at the corrected instant (a DST change near midnight): of the two
	// candidates, the earliest that is on the wanted date.
	const target = new Date(guess).toISOString().slice(0, 10);
	const onDate = [first, guess - offsetAt(first, tz)].filter((ms) => {
		const w = wallTime(new Date(ms), tz);
		return new Date(Date.UTC(w.year, w.month - 1, w.day)).toISOString().slice(0, 10) === target;
	});
	return new Date(onDate.length ? Math.min(...onDate) : first);
}

/** When the current day, week (Monday first) or month began in `tz`. */
export function windowStart(now: Date, period: Period, tz: string) {
	const w = wallTime(now, tz);
	if (period === 'month') return startOfLocalDay(w.year, w.month, 1, tz);
	if (period === 'day') return startOfLocalDay(w.year, w.month, w.day, tz);
	const weekday = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay(); // 0 = Sunday
	return startOfLocalDay(w.year, w.month, w.day - ((weekday + 6) % 7), tz);
}

/** A key naming the week (its Monday, YYYY-MM-DD) an instant falls in, in `tz`. */
export function weekKey(at: Date, tz: string) {
	const w = wallTime(at, tz);
	const weekday = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
	return new Date(Date.UTC(w.year, w.month - 1, w.day - ((weekday + 6) % 7)))
		.toISOString()
		.slice(0, 10);
}
