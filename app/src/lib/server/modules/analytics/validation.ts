import { z } from 'zod';
import type { AnalyticsFilter } from '$lib/shared/analytics';
import { AppError, parse } from '../../validation';

const day = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-09-27.')
	.refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Not a real date.');
const blankIsNull = (v: unknown) => (v === '' || v === undefined ? null : v);

export const analyticsFilter = z.strictObject({
	from: z.preprocess(blankIsNull, day.nullable()),
	to: z.preprocess(blankIsNull, day.nullable()),
	printer: z.preprocess(blankIsNull, z.string().max(80).nullable()),
	person: z.preprocess(blankIsNull, z.string().max(80).nullable()),
	tz: z.preprocess(
		(v) => (v === '' || v === undefined ? 0 : Number(v)),
		z.number().int().min(-840).max(840)
	)
});

/** Reads the dashboard filter from a URL's search parameters (?from&to&printer&person&tz). */
export function readFilter(params: URLSearchParams): AnalyticsFilter {
	const f = parse(analyticsFilter, Object.fromEntries(params));
	if (f.from && f.to && f.from > f.to)
		throw new AppError(400, 'The start date is after the end date.');
	return { from: f.from, to: f.to, printerId: f.printer, profileId: f.person, tz: f.tz };
}
