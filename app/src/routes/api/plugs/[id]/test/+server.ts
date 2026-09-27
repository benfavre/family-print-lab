import { api } from '$lib/server/http';
import { homeAutomation } from '$lib/server/modules/home-automation/service';

/** Asks the plug for its state without switching it (webhooks cannot be asked). */
export const POST = api(async ({ params }, rt) => {
	const ha = homeAutomation(rt);
	const plug = ha.plugs.require(params.id!);
	const started = Date.now();
	try {
		const on = await ha.power.read(plug.printerId);
		const ms = Date.now() - started;
		return on === null
			? {
					ok: true,
					detail: 'Webhooks cannot be asked for their state. Use the power buttons to try them.'
				}
			: { ok: true, detail: `The plug answered in ${ms} ms: it is ${on ? 'on' : 'off'}.`, on };
	} catch (error) {
		return { ok: false, detail: (error as Error).message };
	}
});
