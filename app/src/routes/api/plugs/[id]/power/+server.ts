import { api, readJson } from '$lib/server/http';
import { homeAutomation } from '$lib/server/modules/home-automation/service';
import { powerInput } from '$lib/server/modules/home-automation/validation';
import { PlugError } from '$lib/server/modules/home-automation/plugs';
import { AppError, parse } from '$lib/server/validation';

/** Switches a printer's plug on or off by hand; off is refused while printing or while the nozzle is hot. */
export const POST = api(async ({ request, params }, rt) => {
	const { on } = parse(powerInput, await readJson(request));
	const ha = homeAutomation(rt);
	const plug = ha.plugs.require(params.id!);
	try {
		await ha.power.switch(plug.printerId, on, 'manual');
	} catch (error) {
		if (error instanceof PlugError) throw new AppError(409, error.message);
		throw error;
	}
	return { state: ha.power.state(plug.printerId) };
});
