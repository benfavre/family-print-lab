import { api, readJson } from '$lib/server/http';
import { notifications } from '$lib/server/modules/notifications/api';

/** Marks notifications read: `{ ids }` or `{ all: true }`. */
export const POST = api(async ({ request }, rt) =>
	notifications(rt).markRead(await readJson(request))
);
