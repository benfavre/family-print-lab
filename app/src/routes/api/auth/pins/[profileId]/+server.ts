import { api, readJson } from '$lib/server/http';
import { authContext, authService } from '$lib/server/modules/lan-auth/http';

/** Gives a profile its own PIN for logging in from other devices. */
export const PUT = api(async (event, rt) => {
	const service = authService(rt);
	const ctx = authContext(event);
	await service.setPin(event.params.profileId!, await readJson(event.request, 10_000), ctx);
	return { auth: service.status(ctx) };
});

export const DELETE = api((event, rt) => {
	const service = authService(rt);
	const ctx = authContext(event);
	service.clearPin(event.params.profileId!, ctx);
	return { auth: service.status(ctx) };
});
