import { api, readJson } from '$lib/server/http';
import { AppError, parse } from '$lib/server/validation';
import { amsService } from '$lib/server/modules/ams/service';
import { traySettingsInput } from '$lib/server/modules/ams/validation';
import { presetFor, trayColour } from '$lib/shared/ams';

/** Tells the printer what is in a tray (material, colour, nozzle temperatures). */
export const POST = api(async ({ request, params }, rt) => {
	const o = parse(traySettingsInput, await readJson(request));
	amsService(rt).tray(params.id!, o.tray);
	const preset = presetFor(o.material);
	if (!preset) throw new AppError(400, `The printer has no profile for ${o.material}.`);
	const outcome = await rt.printers.require(params.id!).send('print.ams_filament_setting', {
		tray: o.tray,
		type: preset.type,
		infoIdx: o.infoIdx ?? preset.infoIdx,
		color: trayColour(o.colorHex),
		tempMin: o.tempMin,
		tempMax: o.tempMax
	});
	return { outcome: outcome.outcome };
});
