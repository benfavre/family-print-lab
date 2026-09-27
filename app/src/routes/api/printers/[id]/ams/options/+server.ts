import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';
import { optionsInput } from '$lib/server/modules/ams/validation';

/** The AMS reading options, for every unit (read tags at start-up / on insert, estimate what is left). */
export const POST = api(async ({ request, params }, rt) => {
	const o = parse(optionsInput, await readJson(request));
	const outcome = await rt.printers.require(params.id!).send('print.ams_user_setting', o);
	return { outcome: outcome.outcome };
});
