import { z } from 'zod';
import type { AnalyticsFilter } from '$lib/shared/analytics';
import { AppError, parse } from '../../validation';
import { isTimeZone } from './queries';

const realDay = (v: string) => {
	// Date.parse rolls 2026-02-30 over to 2 March, so check the day survives the round trip.
	const t = Date.parse(`${v}T00:00:00Z`);
	return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
};
const day = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-09-27.')
	.refine(realDay, 'Not a real date.');
const blankIsNull = (v: unknown) => (v === '' || v === undefined ? null : v);

export const analyticsFilter = z.strictObject({
	from: z.preprocess(blankIsNull, day.nullable()),
	to: z.preprocess(blankIsNull, day.nullable()),
	printer: z.preprocess(blankIsNull, z.string().max(80).nullable()),
	person: z.preprocess(blankIsNull, z.string().max(80).nullable()),
	tz: z.preprocess(
		(v) => (v === '' || v === undefined ? 'UTC' : v),
		z.string().max(64).refine(isTimeZone, 'Unknown time zone.')
	)
});

/** Reads the dashboard filter from a URL's search parameters (?from&to&printer&person&tz). */
export function readFilter(params: URLSearchParams): AnalyticsFilter {
	const f = parse(analyticsFilter, Object.fromEntries(params));
	if (f.from && f.to && f.from > f.to)
		throw new AppError(400, 'The start date is after the end date.');
	return { from: f.from, to: f.to, printerId: f.printer, profileId: f.person, tz: f.tz };
}
