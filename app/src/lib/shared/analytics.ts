// The statistics dashboard's vocabulary (/analytics), shared by the server queries and the page.
import type { JobStatus, ProfileColor } from './domain';

/**
 * What the dashboard looks at. Dates are local calendar days (YYYY-MM-DD, both ends included), read
 * in the viewer's time zone (`tz`, minutes east of UTC, like `-new Date().getTimezoneOffset()`).
 * `printerId: 'none'` means jobs that name no printer.
 */
export interface AnalyticsFilter {
	from: string | null;
	to: string | null;
	printerId: string | null;
	profileId: string | null;
	tz: number;
}

export const NO_PRINTER = 'none';

/** Grams, cost and prints for one slice (a month, a material, a person, a printer). */
export interface FilamentSlice {
	key: string;
	label: string;
	grams: number;
	/** Filament cost from the spool price; null when no spool with a price is known for any print. */
	cost: number | null;
	/** Grams whose cost is unknown (no spool, or a spool without a price). */
	uncostedGrams: number;
	/** Succeeded and failed prints (cancelled ones use no filament). */
	prints: number;
}

export interface WeekPoint {
	/** Monday of the week (YYYY-MM-DD, local). */
	week: string;
	succeeded: number;
	failed: number;
	cancelled: number;
	/** succeeded / (succeeded + failed); cancelled prints are left out. Null when nothing finished. */
	rate: number | null;
	grams: number;
}

export interface MonthMaterial {
	/** YYYY-MM, local. */
	month: string;
	material: string;
	grams: number;
	cost: number | null;
}

export interface PrinterHours {
	key: string;
	label: string;
	minutes: number;
	/** Finished prints, cancelled ones included. */
	prints: number;
}

export interface FailureReason {
	reason: string;
	count: number;
	/** Where the text came from: the printer's error report or a job note. */
	source: 'printer' | 'note' | 'none';
}

export interface TopProject {
	id: string;
	title: string;
	owner: string;
	prints: number;
	succeeded: number;
	grams: number;
	cost: number | null;
}

export interface AnalyticsTotals {
	/** Finished prints (succeeded, failed and cancelled). */
	prints: number;
	succeeded: number;
	failed: number;
	cancelled: number;
	/** succeeded / (succeeded + failed), or null. */
	successRate: number | null;
	grams: number;
	cost: number | null;
	uncostedGrams: number;
	/** Printer time of every finished print, in minutes. */
	machineMinutes: number;
	/** Average printing time of a successful print, in minutes, or null. */
	averageMinutes: number | null;
}

export interface AnalyticsSummary {
	filter: AnalyticsFilter;
	totals: AnalyticsTotals;
	weeks: WeekPoint[];
	months: MonthMaterial[];
	byMaterial: FilamentSlice[];
	byPerson: FilamentSlice[];
	byPrinter: FilamentSlice[];
	hours: PrinterHours[];
	failures: FailureReason[];
	/** Whether failure reasons could use the printer's error history (the hms module's table). */
	printerErrors: boolean;
	topProjects: TopProject[];
	/** Choices for the filters. */
	options: {
		printers: { id: string; name: string }[];
		people: { id: string; name: string; color: ProfileColor }[];
	};
}

/** One finished print, as the CSV export lists it. */
export interface AnalyticsRow {
	jobId: string;
	date: string;
	project: string;
	person: string;
	printer: string;
	status: JobStatus;
	material: string;
	grams: number;
	cost: number | null;
	minutes: number | null;
	reason: string;
}

/** The filter as URL search parameters (empty values left out), for the API and the CSV link. */
export function filterParams(f: Partial<AnalyticsFilter>): URLSearchParams {
	const p = new URLSearchParams();
	if (f.from) p.set('from', f.from);
	if (f.to) p.set('to', f.to);
	if (f.printerId) p.set('printer', f.printerId);
	if (f.profileId) p.set('person', f.profileId);
	if (f.tz) p.set('tz', String(f.tz));
	return p;
}
