import { api } from '$lib/server/http';
import { AppError } from '$lib/server/validation';

/** Encrypted backups stored for the account (from any linked computer). */
export const GET = api(async (_, rt) => {
	if (!rt.cloud) throw new AppError(404, 'Print Lab Cloud is not set up here (CLOUD_URL).');
	return { backups: await rt.cloud.listBackups() };
});
