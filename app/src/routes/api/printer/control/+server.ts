import { z } from 'zod';
import { api, readJson } from '$lib/server/http';
import { AppError, parse } from '$lib/server/validation';

/** Pause, resume or stop the current print. */
export const POST = api(async ({ request }, rt) => {
	const { action } = parse(
		z.object({ action: z.enum(['pause', 'resume', 'stop']) }),
		await readJson(request)
	);
	if (!rt.printer) throw new AppError(409, 'No printer is set up yet.');
	try {
		return { outcome: await rt.printer.control(action) };
	} catch (error) {
		throw new AppError(409, (error as Error).message);
	}
});
