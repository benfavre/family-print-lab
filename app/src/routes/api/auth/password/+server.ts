import { api, readJson } from '$lib/server/http';
import { authContext, authService } from '$lib/server/modules/lan-auth/http';

/** Sets the household password, or changes it (with the current one). */
export const PUT = api(async (event, rt) => {
	const service = authService(rt);
	const ctx = authContext(event);
	await service.setPassword(await readJson(event.request, 10_000), ctx);
	return { auth: service.status(ctx) };
});

/** Back to "only this computer" (on the computer itself, with the current password). */
export const DELETE = api(async (event, rt) => {
	const service = authService(rt);
	const ctx = authContext(event);
	await service.clearPassword(await readJson(event.request, 10_000), ctx);
	return { auth: service.status({ ...ctx, session: null }) };
});
