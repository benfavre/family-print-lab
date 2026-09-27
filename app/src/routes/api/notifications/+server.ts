import { api } from '$lib/server/http';
import { notifications } from '$lib/server/modules/notifications/api';

/** The notification centre, newest first (`?before=<createdAt>` pages back). */
export const GET = api(({ url }, rt) =>
	notifications(rt).list({
		limit: Number(url.searchParams.get('limit')) || undefined,
		before: url.searchParams.get('before') || undefined
	})
);

/** Clears the centre. */
export const DELETE = api((_e, rt) => notifications(rt).clear());
