import { z } from 'zod';
import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';
import { clearKidCookie } from '$lib/server/kid/session';

/** Leaves kid mode with the parent PIN. */
export const POST = api(async ({ request, cookies }, rt) => {
	const { pin } = parse(z.strictObject({ pin: z.string().max(8) }), await readJson(request));
	rt.pin.verify(pin);
	clearKidCookie(cookies);
	return { ok: true };
});
