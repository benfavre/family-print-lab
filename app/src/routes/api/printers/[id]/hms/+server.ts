import { api } from '$lib/server/http';
import { AppError, parse } from '$lib/server/validation';
import { historyQuery } from '$lib/server/modules/hms/validation';
import type { HmsPrinterView } from '$lib/shared/hms';

/** A printer's active alerts in plain words, and its alert history (newest first, paginated). */
export const GET = api(({ params, url }, rt): HmsPrinterView => {
	const hms = rt.module('hms');
	if (!hms) throw new AppError(404, 'Printer error help is off.');
	rt.printers.statusOf(params.id!);
	const q = parse(historyQuery, Object.fromEntries(url.searchParams));
	const { rows, total } = hms.history(params.id!, q);
	return { active: hms.active(params.id!), history: rows, total };
});
