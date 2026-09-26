import { z } from 'zod';
import { api, readJson } from '$lib/server/http';
import { AppError, parse } from '$lib/server/validation';

/** The recovery key, for "Show recovery key" (kid mode cannot reach /api/cloud). */
export const GET = api((_, rt) => {
	if (!rt.cloud) throw new AppError(404, 'Print Lab Cloud is not set up here (CLOUD_URL).');
	return { recoveryKey: rt.cloud.recoveryKey() };
});

/** Turns cloud backup on (returns the recovery key) or off, or sends a fresh backup now. */
export const POST = api(async ({ request }, rt) => {
	if (!rt.cloud) throw new AppError(404, 'Print Lab Cloud is not set up here (CLOUD_URL).');
	const { action } = parse(
		z.strictObject({ action: z.enum(['enable', 'disable', 'now']) }),
		await readJson(request)
	);
	if (action === 'enable') return { recoveryKey: rt.cloud.enableBackup(), ...rt.cloud.status() };
	if (action === 'disable') {
		rt.cloud.disableBackup();
		return rt.cloud.status();
	}
	const snapshot = await rt.backups.create('manual');
	await rt.cloud.uploadBackup(`${rt.backups.dir}/${snapshot.file}`);
	rt.lab.touch('backup', 'Backup sent to Print Lab Cloud, encrypted');
	return rt.cloud.status();
});
