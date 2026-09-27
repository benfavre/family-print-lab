// CSV for the statistics export (RFC 4180: CRLF line ends, fields with a comma, quote or line break
// wrapped in double quotes, quotes doubled). https://www.rfc-editor.org/rfc/rfc4180
import type { AnalyticsRow } from '$lib/shared/analytics';

export type Cell = string | number | null | undefined;

/**
 * One field. Text that a spreadsheet would run as a formula (starting with =, +, -, @, tab or carriage
 * return) gets a leading apostrophe, as OWASP advises for CSV exports; numbers stay numbers.
 */
export function csvField(v: Cell): string {
	if (v === null || v === undefined) return '';
	let s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : v;
	if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
	return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A whole document: a header row, then the rows, each line ending in CRLF. */
export function toCsv(header: string[], rows: Cell[][]): string {
	return [header, ...rows].map((r) => r.map(csvField).join(',') + '\r\n').join('');
}

export const EXPORT_HEADER = [
	'Finished',
	'Project',
	'Person',
	'Printer',
	'Result',
	'Material',
	'Filament (g)',
	'Filament cost',
	'Printer time (min)',
	'Failure reason',
	'Job id'
];

/** The export's rows, in EXPORT_HEADER order. */
export function exportCsv(rows: AnalyticsRow[]): string {
	return toCsv(
		EXPORT_HEADER,
		rows.map((r) => [
			r.date,
			r.project,
			r.person,
			r.printer,
			r.status,
			r.material,
			r.grams,
			r.cost,
			r.minutes,
			r.reason,
			r.jobId
		])
	);
}
