import { z } from 'zod';
import { api, readJson } from '$lib/server/http';
import { AppError, parse } from '$lib/server/validation';

/** @deprecated Pause, resume or stop the first printer's print; use /api/printers/[id]/control. */
export const POST = api(async ({ request }, rt) => {
	const { action } = parse(
		z.object({ action: z.enum(['pause', 'resume', 'stop']) }),
		await readJson(request)
	);
	const printer = rt.printers.primary();
	if (!printer) throw new AppError(409, 'No printer is set up yet.');
	return { outcome: await printer.control(action) };
});
