import { api } from '$lib/server/http';

export const GET = api((_e, rt) => rt.aiSummary());
