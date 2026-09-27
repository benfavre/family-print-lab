import { api } from '$lib/server/http';
import { authContext, authService } from '$lib/server/modules/lan-auth/http';

/** Login settings and signed-in devices (the full list only for whoever may change them). */
export const GET = api((event, rt) => authService(rt).status(authContext(event)));
