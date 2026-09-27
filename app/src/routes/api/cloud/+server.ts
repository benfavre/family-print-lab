import { z } from 'zod';
import { api, readJson } from '$lib/server/http';
import { AppError, parse } from '$lib/server/validation';
import { CLOUD_OFF } from '$lib/shared/cloud';

/** The Print Lab Cloud link's status (see docs/cloud-protocol.md). */
export const GET = api((_, rt) => rt.cloud?.status() ?? CLOUD_OFF);

/**
 * Settings: whether kids' first names are sent with their requests, and what the phone may see and
 * do with the printers. Turning remote control on needs the parent PIN.
 */
export const PATCH = api(async ({ request }, rt) => {
	if (!rt.cloud) throw new AppError(404, 'Print Lab Cloud is not set up here (CLOUD_URL).');
	const { shareNames, pin, ...remote } = parse(
		z.strictObject({
			shareNames: z.boolean().optional(),
			shareProgress: z.boolean().optional(),
			shareAlerts: z.boolean().optional(),
			shareQueue: z.boolean().optional(),
			snapshots: z.boolean().optional(),
			remoteControl: z.boolean().optional(),
			pin: z.string().max(8).optional()
		}),
		await readJson(request)
	);
	if (remote.remoteControl && !rt.cloud.remoteSettings().remoteControl) {
		if (!rt.pin.isSet()) throw new AppError(409, 'Set a parent PIN first.');
		rt.pin.verify(pin ?? '');
		rt.lab.touch('cloud', 'Remote control from the phone turned on');
	}
	if (shareNames !== undefined) rt.cloud.setShareNames(shareNames);
	const changes = Object.fromEntries(Object.entries(remote).filter(([, v]) => v !== undefined));
	if (Object.keys(changes).length) rt.cloud.setRemote(changes);
	return rt.cloud.status();
});
