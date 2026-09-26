import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { api, readJson } from '$lib/server/http';
import { AppError, parse } from '$lib/server/validation';
import { open, unpack, VaultError } from '$lib/server/cloud/vault';

const body = z.strictObject({
	id: z.string().min(1).max(300),
	/** Needed when the backup was made on another computer (or before this one got a new key). */
	recoveryKey: z.string().max(80).optional()
});

/**
 * Restores a cloud backup: downloads it, opens it with the recovery key, keeps it as a local
 * snapshot, then puts it back like any other backup (a safety snapshot is taken first).
 */
export const POST = api(async ({ request }, rt) => {
	if (!rt.cloud) throw new AppError(404, 'Print Lab Cloud is not set up here (CLOUD_URL).');
	const { id, recoveryKey } = parse(body, await readJson(request));
	const key = recoveryKey || rt.cloud.recoveryKey();
	if (!key)
		throw new AppError(400, 'Enter the recovery key written down when cloud backup was turned on.');
	const sealed = await rt.cloud.downloadBackup(id);
	let packed: Buffer;
	try {
		packed = open(sealed, key);
	} catch (error) {
		if (error instanceof VaultError) throw new AppError(400, error.message);
		throw error;
	}
	const file = `printlab-${new Date().toISOString().replace(/[:.]/g, '-')}-from-cloud`;
	const dir = path.join(rt.backups.dir, file);
	try {
		unpack(packed, dir);
	} catch (error) {
		fs.rmSync(dir, { recursive: true, force: true });
		throw new AppError(400, (error as Error).message);
	}
	const result = await rt.backups.restore(file);
	rt.models.sweep();
	rt.printing.sweep();
	rt.lab.touch('import', 'Workspace restored from a Print Lab Cloud backup');
	return { restored: result };
});
