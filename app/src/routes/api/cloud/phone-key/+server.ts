import { z } from 'zod';
import { api, readJson } from '$lib/server/http';
import { AppError, parse } from '$lib/server/validation';

/**
 * The household phone key, behind the parent PIN: `show` returns the link a phone opens to keep it
 * (the key is in the link's fragment; the page draws it as a QR code), `forget` makes a new key so
 * every phone must scan again.
 */
export const POST = api(async ({ request }, rt) => {
	if (!rt.cloud) throw new AppError(404, 'Print Lab Cloud is not set up here (CLOUD_URL).');
	const { action, pin } = parse(
		z.strictObject({ action: z.enum(['show', 'forget']), pin: z.string().max(8) }),
		await readJson(request)
	);
	if (!rt.pin.isSet()) throw new AppError(409, 'Set a parent PIN first.');
	rt.pin.verify(pin);
	if (action === 'forget') rt.cloud.forgetPhones();
	return { ...rt.cloud.phoneKey(), status: rt.cloud.status() };
});
