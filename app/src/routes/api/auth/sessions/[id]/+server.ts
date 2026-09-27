import { api } from '$lib/server/http';
import { authContext, authService, clearSessionCookie } from '$lib/server/modules/lan-auth/http';

/** Logs one device out (Access from other devices → Signed-in devices). */
export const DELETE = api((event, rt) => {
	const service = authService(rt);
	let ctx = authContext(event);
	service.endSession(event.params.id!, ctx);
	if (ctx.session?.id === event.params.id) {
		clearSessionCookie(event.cookies);
		ctx = { ...ctx, session: null };
	}
	return { auth: service.status(ctx) };
});
