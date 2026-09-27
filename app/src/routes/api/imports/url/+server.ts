import { api, readJson } from '$lib/server/http';
import { importsOf } from '$lib/server/modules/model-import/route';

/** Reads a model page link: details, licence, pictures and files, without importing anything. */
export const POST = api(async ({ request }, rt) => {
	const preview = await importsOf(rt).imports.preview(
		await readJson(request, 10_000),
		request.signal
	);
	return { preview };
});
