import { json } from '@sveltejs/kit';
import { api } from '$lib/server/http';
import { AppError } from '$lib/server/validation';

/** cancel: stop a running task (closes Blender for a Blender session). dismiss: forget a finished one. */
export const POST = api(({ params }, rt) => {
	if (params.action === 'cancel') return json(rt.tasks.cancel(params.id!));
	if (params.action === 'dismiss') {
		rt.tasks.dismiss(params.id!);
		return new Response(null, { status: 204 });
	}
	throw new AppError(404, 'Unknown task action.');
});
