// The statistics dashboard's numbers, as SQL aggregates over finished print jobs.
//
// Rules (they match how the lab charges spools, see Lab.settle):
// - Only finished jobs count: Succeeded, Failed and Cancelled, dated by when they finished (else when
//   they started, else when they were made), in the viewer's time zone.
// - Success rate is succeeded / (succeeded + failed); cancelled prints are left out.
// - Filament: succeeded and failed prints use their grams; cancelled prints use none.
// - Cost per gram is the spool's price / its total grams; prints without a spool, or on a spool with no
//   price, add grams but no cost (counted as "uncosted" so the page can say so).
// - Printer time: the measured time, else (cancelled) the time between start and finish, else the
//   slicer estimate.
// - Failure reasons: the printer's error text from the hms module's table when it exists and has rows
//   for the job, else the first line of the job's notes.
import type { DB } from '../../db';
import {
	NO_PRINTER,
	type AnalyticsFilter,
	type AnalyticsRow,
	type AnalyticsSummary,
	type FailureReason,
	type FilamentSlice,
	type MonthMaterial,
	type PrinterHours,
	type TopProject,
	type WeekPoint
} from '$lib/shared/analytics';
import type { JobStatus, ProfileColor } from '$lib/shared/domain';

const TOP = 8;
const MAX_WEEKS = 160;
const UNKNOWN_MATERIAL = 'Unknown';
const NO_PRINTER_LABEL = 'No printer set';

/** Every finished job with what the dashboard needs, filtered. Parameters: @tz @from @to @printer @person. */
const FINISHED = `
WITH base AS (
	SELECT
		j.id AS id,
		j.status AS status,
		j.project_id AS projectId,
		p.title AS title,
		p.profile_id AS profileId,
		pr.name AS owner,
		j.printer_id AS printerId,
		pt.name AS printerName,
		COALESCE(NULLIF(s.material, ''), NULLIF(j.material, ''), '${UNKNOWN_MATERIAL}') AS material,
		CASE WHEN j.status IN ('Succeeded', 'Failed') THEN COALESCE(j.grams, 0) ELSE 0 END AS grams,
		CASE WHEN s.cost IS NOT NULL AND s.total_grams > 0 THEN s.cost / s.total_grams END AS perGram,
		COALESCE(
			j.actual_minutes,
			CASE
				WHEN j.status <> 'Cancelled' THEN j.minutes
				WHEN NULLIF(j.started_at, '') IS NOT NULL AND NULLIF(j.finished_at, '') IS NOT NULL
					THEN MAX(0, ROUND((julianday(j.finished_at) - julianday(j.started_at)) * 1440))
			END
		) AS minutes,
		j.notes AS notes,
		datetime(COALESCE(NULLIF(j.finished_at, ''), NULLIF(j.started_at, ''), j.created_at), @tz) AS local
	FROM jobs j
	JOIN projects p ON p.id = j.project_id
	JOIN profiles pr ON pr.id = p.profile_id
	LEFT JOIN spools s ON s.id = COALESCE(j.spool_id, j.charge_spool_id)
	LEFT JOIN printers pt ON pt.id = j.printer_id
	WHERE j.status IN ('Succeeded', 'Failed', 'Cancelled')
),
f AS (
	SELECT *, grams * perGram AS cost FROM base
	WHERE (@from IS NULL OR date(local) >= @from)
		AND (@to IS NULL OR date(local) <= @to)
		AND (@printer IS NULL OR (@printer = '${NO_PRINTER}' AND printerId IS NULL) OR printerId = @printer)
		AND (@person IS NULL OR profileId = @person)
)`;

/** A filament slice: grams, cost, uncosted grams and prints, for a GROUP BY. */
const SLICE = `
	SUM(grams) AS grams,
	SUM(cost) AS cost,
	SUM(CASE WHEN perGram IS NULL THEN grams ELSE 0 END) AS uncostedGrams,
	SUM(CASE WHEN status <> 'Cancelled' THEN 1 ELSE 0 END) AS prints`;

function params(f: AnalyticsFilter) {
	return {
		tz: `${f.tz >= 0 ? '+' : ''}${f.tz} minutes`,
		from: f.from,
		to: f.to,
		printer: f.printerId,
		person: f.profileId
	};
}

/** Whether a table exists (other packages' tables are optional). */
function hasTable(db: DB, name: string) {
	return !!db.$client
		.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
		.get(name);
}

const round = (v: number, digits = 2) => {
	const k = 10 ** digits;
	return Math.round(v * k) / k;
};
const money = (v: number | null) => (v === null ? null : round(v));
const rate = (succeeded: number, failed: number) =>
	succeeded + failed ? succeeded / (succeeded + failed) : null;

/** The first line of a note, trimmed to a short reason. */
export function noteReason(notes: string): string {
	const line = notes.trim().split(/\r?\n/)[0].trim();
	return line.length > 120 ? `${line.slice(0, 119).trimEnd()}…` : line;
}

/** Monday of the week holding a YYYY-MM-DD day. */
export function weekOf(day: string): string {
	const d = new Date(`${day}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
	return d.toISOString().slice(0, 10);
}

/** Every Monday from the week of `from` to the week of `to`, at most `max` (the latest ones). */
export function weeksBetween(from: string, to: string, max = MAX_WEEKS): string[] {
	const out: string[] = [];
	const end = Date.parse(`${weekOf(to)}T00:00:00Z`);
	for (let t = Date.parse(`${weekOf(from)}T00:00:00Z`); t <= end; t += 7 * 86_400_000)
		out.push(new Date(t).toISOString().slice(0, 10));
	return out.slice(-max);
}

type SliceRow = {
	key: string | null;
	label: string | null;
	grams: number;
	cost: number | null;
	uncostedGrams: number;
	prints: number;
};
const slice = (r: SliceRow, key: string, label: string): FilamentSlice => ({
	key,
	label,
	grams: round(r.grams),
	cost: money(r.cost),
	uncostedGrams: round(r.uncostedGrams),
	prints: r.prints
});

/** Failure reasons per failed job (the printer's error text first, else the job's first note line). */
function failureReasons(db: DB, f: AnalyticsFilter, printerErrors: boolean) {
	const failed = db.$client
		.prepare(`${FINISHED} SELECT id, notes FROM f WHERE status = 'Failed'`)
		.all(params(f)) as { id: string; notes: string }[];
	const fromPrinter = new Map<string, string[]>();
	if (printerErrors && failed.length) {
		const rows = db.$client
			.prepare(
				`${FINISHED}
				SELECT DISTINCT h.job_id AS jobId, TRIM(h.text) AS text
				FROM hms_events h JOIN f ON f.id = h.job_id
				WHERE f.status = 'Failed' AND TRIM(COALESCE(h.text, '')) <> ''
				ORDER BY h.raised_at`
			)
			.all(params(f)) as { jobId: string; text: string }[];
		for (const r of rows) fromPrinter.set(r.jobId, [...(fromPrinter.get(r.jobId) ?? []), r.text]);
	}
	const byJob = new Map<string, { reasons: string[]; source: FailureReason['source'] }>();
	for (const j of failed) {
		const printer = fromPrinter.get(j.id);
		const note = noteReason(j.notes ?? '');
		byJob.set(
			j.id,
			printer
				? { reasons: printer, source: 'printer' }
				: note
					? { reasons: [note], source: 'note' }
					: { reasons: ['No reason noted'], source: 'none' }
		);
	}
	return byJob;
}

/** Counts reasons, most common first; the tail folds into "Other reasons". */
function countReasons(
	byJob: Map<string, { reasons: string[]; source: FailureReason['source'] }>
): FailureReason[] {
	const counts = new Map<string, FailureReason>();
	for (const { reasons, source } of byJob.values())
		for (const reason of reasons) {
			const hit = counts.get(reason);
			if (hit) hit.count++;
			else counts.set(reason, { reason, count: 1, source });
		}
	const sorted = [...counts.values()].sort(
		(a, b) =>
			Number(a.source === 'none') - Number(b.source === 'none') ||
			b.count - a.count ||
			a.reason.localeCompare(b.reason)
	);
	if (sorted.length <= TOP) return sorted;
	const rest = sorted.slice(TOP - 1);
	return [
		...sorted.slice(0, TOP - 1),
		{ reason: 'Other reasons', count: rest.reduce((n, r) => n + r.count, 0), source: 'none' }
	];
}

/** Everything the dashboard shows for one filter. */
export function summary(db: DB, f: AnalyticsFilter): AnalyticsSummary {
	const p = params(f);
	const all = <T>(sql: string) => db.$client.prepare(`${FINISHED} ${sql}`).all(p) as T[];

	const t = all<{
		prints: number;
		succeeded: number;
		failed: number;
		cancelled: number;
		grams: number | null;
		cost: number | null;
		uncostedGrams: number | null;
		machineMinutes: number | null;
		averageMinutes: number | null;
	}>(`SELECT
		COUNT(*) AS prints,
		SUM(status = 'Succeeded') AS succeeded,
		SUM(status = 'Failed') AS failed,
		SUM(status = 'Cancelled') AS cancelled,
		SUM(grams) AS grams,
		SUM(cost) AS cost,
		SUM(CASE WHEN perGram IS NULL THEN grams ELSE 0 END) AS uncostedGrams,
		SUM(COALESCE(minutes, 0)) AS machineMinutes,
		AVG(CASE WHEN status = 'Succeeded' THEN minutes END) AS averageMinutes
	FROM f`)[0];

	const weekRows = all<{
		week: string;
		succeeded: number;
		failed: number;
		cancelled: number;
		grams: number;
	}>(`SELECT
		date(local, '-6 days', 'weekday 1') AS week,
		SUM(status = 'Succeeded') AS succeeded,
		SUM(status = 'Failed') AS failed,
		SUM(status = 'Cancelled') AS cancelled,
		SUM(grams) AS grams
	FROM f GROUP BY week ORDER BY week`);
	const byWeek = new Map(weekRows.map((w) => [w.week, w]));
	const first = f.from ?? weekRows[0]?.week;
	const last = f.to ?? weekRows.at(-1)?.week;
	const weeks: WeekPoint[] =
		first && last
			? weeksBetween(first, last).map((week) => {
					const w = byWeek.get(week);
					const succeeded = w?.succeeded ?? 0,
						failed = w?.failed ?? 0;
					return {
						week,
						succeeded,
						failed,
						cancelled: w?.cancelled ?? 0,
						rate: rate(succeeded, failed),
						grams: round(w?.grams ?? 0)
					};
				})
			: [];

	const months = all<MonthMaterial>(`SELECT
		strftime('%Y-%m', local) AS month, material, SUM(grams) AS grams, SUM(cost) AS cost
	FROM f WHERE grams > 0 GROUP BY month, material ORDER BY month, grams DESC`).map((m) => ({
		...m,
		grams: round(m.grams),
		cost: money(m.cost)
	}));

	const byMaterial = all<SliceRow>(
		`SELECT material AS key, material AS label, ${SLICE} FROM f
		GROUP BY material HAVING SUM(grams) > 0 OR prints > 0 ORDER BY grams DESC, label`
	).map((r) => slice(r, r.key ?? UNKNOWN_MATERIAL, r.label ?? UNKNOWN_MATERIAL));
	const byPerson = all<SliceRow>(
		`SELECT profileId AS key, owner AS label, ${SLICE} FROM f
		GROUP BY profileId ORDER BY grams DESC, label`
	).map((r) => slice(r, r.key ?? '', r.label ?? ''));
	const byPrinter = all<SliceRow>(
		`SELECT printerId AS key, printerName AS label, ${SLICE} FROM f
		GROUP BY printerId ORDER BY grams DESC, label`
	).map((r) => slice(r, r.key ?? NO_PRINTER, r.label ?? NO_PRINTER_LABEL));

	const printerList = db.$client
		.prepare(`SELECT id, name FROM printers ORDER BY sort_order, name`)
		.all() as { id: string; name: string }[];
	const hourRows = all<{
		key: string | null;
		label: string | null;
		minutes: number;
		prints: number;
	}>(
		`SELECT printerId AS key, printerName AS label, SUM(COALESCE(minutes, 0)) AS minutes,
			COUNT(*) AS prints
		FROM f GROUP BY printerId`
	);
	const hours: PrinterHours[] = hourRows.map((r) => ({
		key: r.key ?? NO_PRINTER,
		label: r.label ?? NO_PRINTER_LABEL,
		minutes: Math.round(r.minutes),
		prints: r.prints
	}));
	// Saved printers with no finished prints still get a row (unless the filter names one printer).
	if (!f.printerId)
		for (const pr of printerList)
			if (!hours.some((h) => h.key === pr.id))
				hours.push({ key: pr.id, label: pr.name, minutes: 0, prints: 0 });
	hours.sort((a, b) => b.minutes - a.minutes || a.label.localeCompare(b.label));

	const printerErrors = hasTable(db, 'hms_events');
	const failures = countReasons(failureReasons(db, f, printerErrors));

	const topProjects = all<{
		id: string;
		title: string;
		owner: string;
		prints: number;
		succeeded: number;
		grams: number;
		cost: number | null;
	}>(`SELECT projectId AS id, title, owner, COUNT(*) AS prints,
		SUM(status = 'Succeeded') AS succeeded, SUM(grams) AS grams, SUM(cost) AS cost
	FROM f GROUP BY projectId ORDER BY prints DESC, grams DESC, title LIMIT ${TOP}`).map(
		(r): TopProject => ({ ...r, grams: round(r.grams), cost: money(r.cost) })
	);

	const people = db.$client
		.prepare(`SELECT id, name, color FROM profiles ORDER BY created_at, name`)
		.all() as { id: string; name: string; color: ProfileColor }[];

	return {
		filter: f,
		totals: {
			prints: t.prints,
			succeeded: t.succeeded ?? 0,
			failed: t.failed ?? 0,
			cancelled: t.cancelled ?? 0,
			successRate: rate(t.succeeded ?? 0, t.failed ?? 0),
			grams: round(t.grams ?? 0),
			cost: money(t.cost),
			uncostedGrams: round(t.uncostedGrams ?? 0),
			machineMinutes: Math.round(t.machineMinutes ?? 0),
			averageMinutes: t.averageMinutes === null ? null : Math.round(t.averageMinutes)
		},
		weeks,
		months,
		byMaterial,
		byPerson,
		byPrinter,
		hours,
		failures,
		printerErrors,
		topProjects,
		options: { printers: printerList, people }
	};
}

/** Every finished print for the CSV export, newest first. */
export function rows(db: DB, f: AnalyticsFilter): AnalyticsRow[] {
	const list = db.$client
		.prepare(
			`${FINISHED}
			SELECT id, strftime('%Y-%m-%d %H:%M', local) AS date, title, owner, printerName, status,
				material, grams, cost, minutes
			FROM f ORDER BY local DESC, title`
		)
		.all(params(f)) as {
		id: string;
		date: string;
		title: string;
		owner: string;
		printerName: string | null;
		status: JobStatus;
		material: string;
		grams: number;
		cost: number | null;
		minutes: number | null;
	}[];
	const reasons = failureReasons(db, f, hasTable(db, 'hms_events'));
	return list.map((r) => {
		const why = reasons.get(r.id);
		return {
			jobId: r.id,
			date: r.date,
			project: r.title,
			person: r.owner,
			printer: r.printerName ?? NO_PRINTER_LABEL,
			status: r.status,
			material: r.material,
			grams: round(r.grams),
			cost: money(r.cost),
			minutes: r.minutes === null ? null : Math.round(r.minutes),
			reason: why && why.source !== 'none' ? why.reasons.join('; ') : ''
		};
	});
}
