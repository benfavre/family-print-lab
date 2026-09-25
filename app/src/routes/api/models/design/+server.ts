import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { api, readJson } from '$lib/server/http';
import { AppError, parse } from '$lib/server/validation';
import { design } from '$lib/server/cad/requests';
import { designPart } from '$lib/server/ai/cad';
import { validImage } from '$lib/server/ai/assistant';
import { projects } from '$lib/server/db/schema';
import { AI_PROVIDER_NAME } from '$lib/shared/integrations';

/**
 * Starts an AI design as a background task and returns it at once. Progress and the result arrive over
 * the live event stream; nothing is saved until someone turns the suggestion into a model.
 */
export const POST = api(async ({ request }, rt) => {
	const input = parse(design, await readJson(request, 12_000_000));
	const project = rt.db.select().from(projects).where(eq(projects.id, input.projectId)).get();
	if (!project) throw new AppError(404, 'That project no longer exists.');
	if (!input.prompt.trim()) throw new AppError(400, 'Describe the part you want.');
	const image = validImage(input.image);
	// A request can name its AI (the design dialog's picker); otherwise Settings decide.
	const provider = input.provider ? rt.providerById(input.provider) : rt.provider('cad');
	const started = performance.now();
	const task = rt.tasks.start(
		{
			kind: 'ai-design',
			title: input.prompt.trim().split('\n')[0].slice(0, 80),
			projectId: project.id,
			provider: provider.id,
			stage: `Asking ${AI_PROVIDER_NAME[provider.id]}…`
		},
		(ctx) =>
			designPart(
				provider,
				{
					prompt: input.prompt,
					projectTitle: project.title,
					projectDescription: project.description,
					image
				},
				ctx.signal,
				ctx.stage
			),
		(result) => ({
			suggestion: {
				...result,
				provider: provider.id,
				seconds: Math.round((performance.now() - started) / 1000)
			}
		})
	);
	return json({ task }, { status: 202 });
});
