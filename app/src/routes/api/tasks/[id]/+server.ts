import { api } from '$lib/server/http';

export const GET = api(({ params }, rt) => rt.tasks.get(params.id!));
