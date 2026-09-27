import { z } from 'zod';
import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';
import { clearKidCookie } from '$lib/server/kid/session';
import { isSecure } from '$lib/server/modules/lan-auth/http';

/** Leaves kid mode with the parent PIN. */
export const POST = api(async (event, rt) => {
	const { request, cookies } = event;
	const { pin } = parse(z.strictObject({ pin: z.string().max(8) }), await readJson(request));
	rt.pin.verify(pin);
	clearKidCookie(cookies, isSecure(event));
	return { ok: true };
});
