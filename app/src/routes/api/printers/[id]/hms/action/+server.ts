import { api, readJson } from '$lib/server/http';
import { AppError, parse } from '$lib/server/validation';
import { actionBody } from '$lib/server/modules/hms/validation';

/** Presses one of the buttons Bambu defines for an active error ({ code, actionId }). */
export const POST = api(async ({ request, params }, rt) => {
	const hms = rt.module('hms');
	if (!hms) throw new AppError(404, 'Printer error help is off.');
	const body = parse(actionBody, await readJson(request, 10_000));
	return hms.runAction(params.id!, body.code, body.actionId);
});
