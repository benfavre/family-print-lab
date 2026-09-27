import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';
import { dryingInput } from '$lib/server/modules/ams/validation';

/** Starts or stops drying in one AMS unit. */
export const POST = api(async ({ request, params }, rt) => {
	const o = parse(dryingInput, await readJson(request));
	const printer = rt.printers.require(params.id!);
	const outcome =
		o.action === 'stop'
			? await printer.send('print.ams_filament_drying:stop', { amsId: o.amsId })
			: await printer.send('print.ams_filament_drying', {
					amsId: o.amsId,
					temp: o.temp,
					hours: o.hours,
					filament: o.filament,
					rotateTray: o.rotateTray
				});
	return { outcome: outcome.outcome };
});
