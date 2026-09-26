import { api, readJson } from '$lib/server/http';

/**
 * Connects with the given details without saving and reports what it found. With `id` and no access
 * code, the saved one is used.
 */
export const POST = api(async ({ request }, rt) => {
	const result = await rt.printers.test(await readJson(request));
	// A test changes nothing the browser needs to reload.
	return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
});
