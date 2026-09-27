import { api, readJson } from '$lib/server/http';
import { amsService } from '$lib/server/modules/ams/service';

/** Spoolman settings (the token is never sent back: hasToken says whether one is saved). */
export const GET = api((_event, rt) => amsService(rt).spoolman.view());

export const PUT = api(async ({ request }, rt) => ({
	spoolman: amsService(rt).spoolman.save(await readJson(request, 10_000))
}));
