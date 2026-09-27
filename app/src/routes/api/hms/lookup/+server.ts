import { api } from '$lib/server/http';
import { AppError, parse } from '$lib/server/validation';
import { lookupQuery } from '$lib/server/modules/hms/validation';
import { parseCodeInput } from '$lib/shared/hms';

/** One code in plain words, for a printer (its model's texts) or a model, else the generic text. */
export const GET = api(({ url }, rt) => {
	const hms = rt.module('hms');
	if (!hms) throw new AppError(404, 'Printer error help is off.');
	const q = parse(lookupQuery, Object.fromEntries(url.searchParams));
	const code = parseCodeInput(q.code);
	if (!code)
		throw new AppError(
			400,
			'Codes look like 0700_2000_0002_0001 (alerts) or 0700_8011 (print errors).'
		);
	if (q.printerId) rt.printers.statusOf(q.printerId);
	return hms.lookup(code.kind, code.key, { printerId: q.printerId, model: q.model });
});
