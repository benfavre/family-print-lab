import { api } from '$lib/server/http';

/** Recent and running background tasks. */
export const GET = api((_, rt) => rt.tasks.list());
