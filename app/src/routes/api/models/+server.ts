import { api, readJson } from '$lib/server/http';
import { parse } from '$lib/server/validation';
import { createModel } from '$lib/server/cad/requests';

/** Creates a parametric model (from the starter template, or from given source such as an AI design). */
export const POST = api(async ({ request }, rt) => {
	const input = parse(createModel, await readJson(request, 400_000));
	const id = await rt.models.createParametric(
		input.projectId,
		input.name,
		input.source,
		input.origin,
		input.note ?? (input.origin === 'ai' ? 'Designed with AI' : 'Created')
	);
	if (input.taskId) rt.tasks.markUsed(input.taskId, id);
	return { id };
});
