import { api, readJson } from '$lib/server/http';

export const GET = api(({ params }, rt) => rt.printers.statusOf(params.id!));

/** Versioned edit; an empty access code keeps the saved one. */
export const PATCH = api(async ({ request, params }, rt) => ({
	printer: rt.printers.update(params.id!, await readJson(request))
}));

/** Forgets the printer; jobs keep their history (their printer becomes "any"). */
export const DELETE = api(({ params }, rt) => {
	rt.printers.remove(params.id!);
	return { ok: true };
});
