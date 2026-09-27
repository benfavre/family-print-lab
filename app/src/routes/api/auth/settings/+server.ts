import { api, readJson } from '$lib/server/http';
import {
	authContext,
	authService,
	isSecure,
	setSessionCookie
} from '$lib/server/modules/lan-auth/http';

/** Profile PINs on or off; "Require login here too" (needs the current password). */
export const PATCH = api(async (event, rt) => {
	const service = authService(rt);
	let ctx = authContext(event);
	const started = await service.update(await readJson(event.request, 10_000), ctx);
	if (started) {
		setSessionCookie(event.cookies, started.token, isSecure(event));
		ctx = { ...ctx, session: started.row };
	}
	return { auth: service.status(ctx) };
});
