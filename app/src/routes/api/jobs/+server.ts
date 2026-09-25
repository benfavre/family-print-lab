import { api, readJson } from '$lib/server/http';

export const POST = api(async ({ request }, rt) => ({
	id: rt.lab.createJob(await readJson(request))
}));
