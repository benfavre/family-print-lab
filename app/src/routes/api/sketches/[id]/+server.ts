import { z } from 'zod';
import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';
import { readBinary } from '$lib/server/cad/requests';

/** The sketch image. The URL carries the version, so it can be cached for good. */
export const GET = api(({ params }, rt) => {
	return new Response(new Uint8Array(rt.sketches.png(params.id!)), {
		headers: {
			'content-type': 'image/png',
			'cache-control': 'private, max-age=31536000, immutable'
		}
	});
});

/** Replaces the drawing. ?version= is the version the editor started from (stale saves are refused). */
export const PUT = api(async ({ request, params, url }, rt) => {
	const version = url.searchParams.get('version');
	rt.sketches.update(
		params.id!,
		await readBinary(request, 4_000_000),
		version === null ? undefined : Number(version)
	);
	return { ok: true };
});

export const PATCH = api(async ({ request, params }, rt) => {
	rt.sketches.rename(
		params.id!,
		parse(z.strictObject({ title: z.string().max(80) }), await readJson(request)).title
	);
	return { ok: true };
});

export const DELETE = api(({ params }, rt) => {
	rt.sketches.remove(params.id!);
	return { ok: true };
});
