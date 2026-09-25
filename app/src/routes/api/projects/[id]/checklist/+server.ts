import { api, readJson } from '$lib/server/http';

/** Add one step. */
export const POST = api(async ({ request, params }, rt) => ({
	id: rt.lab.addStep(params.id!, ((await readJson(request)) as { text?: unknown }).text)
}));
/** Replace or extend the whole list: { steps: string[], mode: 'replace' | 'append' }. */
export const PUT = api(async ({ request, params }, rt) =>
	rt.lab.setChecklist(params.id!, await readJson(request))
);
