import { z } from 'zod';
import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';

const body = z.object({
	file: z
		.string()
		.regex(/^printlab-[\w-]+$/)
		.max(120)
});

/** Puts a snapshot back (projects, jobs, spools, models, sketches). A safety snapshot is taken first. */
export const POST = api(async ({ request }, rt) => {
	const { file } = parse(body, await readJson(request));
	const result = await rt.backups.restore(file);
	rt.models.sweep();
	rt.printing.sweep();
	rt.lab.touch('import', `Workspace restored from the backup of ${file.slice(9, 19)}`);
	return { restored: result };
});
