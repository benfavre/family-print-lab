import { z } from 'zod';
import { api, readJson } from '$lib/server/http';
import { AppError, parse } from '$lib/server/validation';
import { setKidCookie } from '$lib/server/kid/session';
import { isSecure } from '$lib/server/modules/lan-auth/http';

/** Puts this browser in kid mode for a kid profile. Switching to another child needs the parent PIN. */
export const POST = api(async (event, rt) => {
	const { request, cookies, locals } = event;
	const { profileId, pin } = parse(
		z.strictObject({ profileId: z.string().max(80), pin: z.string().max(8).optional() }),
		await readJson(request)
	);
	const profile = rt.lab.snapshot().profiles.find((p) => p.id === profileId);
	if (!profile?.kid) throw new AppError(404, 'That is not a kid profile.');
	if (!rt.pin.isSet())
		throw new AppError(409, 'Set a parent PIN first, so only grown-ups can leave kid mode.');
	if (locals.kid && locals.kid.id !== profileId) rt.pin.verify(pin ?? '');
	// Not url.protocol: adapter-node reports https without ORIGIN, and a Secure cookie over plain http
	// to a LAN name (a tablet at http://printlab.local) is dropped by the browser.
	setKidCookie(cookies, profileId, isSecure(event));
	return { ok: true };
});
