import { api } from '$lib/server/http';
import { AppError } from '$lib/server/validation';
import { readFilter } from '$lib/server/modules/analytics/validation';
import { exportCsv } from '$lib/server/modules/analytics/csv';

/** Every finished print matching the dashboard filter, as CSV (RFC 4180) for a spreadsheet. */
export const GET = api(({ url }, rt) => {
	const analytics = rt.module('analytics');
	if (!analytics) throw new AppError(503, 'Statistics are not available right now.');
	const filter = readFilter(url.searchParams);
	const date = new Date().toISOString().slice(0, 10);
	// The byte order mark lets spreadsheet apps read names with accents as UTF-8.
	return new Response(`\ufeff${exportCsv(analytics.rows(filter))}`, {
		headers: {
			'content-type': 'text/csv; charset=utf-8; header=present',
			'content-disposition': `attachment; filename="family-print-lab-stats-${date}.csv"`,
			'cache-control': 'no-store'
		}
	});
});
