import { json } from '@sveltejs/kit';
import { api, readJson } from '$lib/server/http';
import { AppError, parse } from '$lib/server/validation';
import { aiEdit, blenderAction, meshOp, restore, saveVersion } from '$lib/server/cad/requests';
import { editPart } from '$lib/server/ai/cad';
import { validImage } from '$lib/server/ai/assistant';
import { RenderFailed } from '$lib/server/models';
import { AI_PROVIDER_NAME } from '$lib/shared/integrations';

/** Actions on one model. Each one that changes geometry creates a new version. */
export const POST = api(async ({ request, params }, rt) => {
	const id = params.id!;
	switch (params.action) {
		case 'versions': {
			const input = parse(saveVersion, await readJson(request, 400_000));
			try {
				const { taskId, ...version } = input;
				const versionId = await rt.models.saveParametric(id, version);
				if (taskId) rt.tasks.markUsed(taskId, versionId);
				return { versionId };
			} catch (error) {
				// Keep the compiler messages so the editor can mark the lines.
				if (error instanceof RenderFailed)
					return json({ error: error.message, diagnostics: error.diagnostics }, { status: 422 });
				throw error;
			}
		}
		case 'restore':
			rt.models.restore(id, parse(restore, await readJson(request)).versionId);
			return { ok: true };
		case 'ops':
			return { versionId: await rt.models.op(id, parse(meshOp, await readJson(request))) };
		case 'mesh-copy':
			return { id: rt.models.meshCopy(id) };
		case 'blender': {
			const input = parse(blenderAction, await readJson(request));
			if (input.action === 'open') return rt.models.openInBlender(id);
			return rt.models.blenderJob(id, input.action, input.ratio);
		}
		case 'ai-edit': {
			const input = parse(aiEdit, await readJson(request, 12_000_000));
			const model = rt.models.model(id);
			if (model.kind !== 'parametric')
				throw new AppError(400, 'AI editing works on parametric models.');
			if (!input.instruction.trim()) throw new AppError(400, 'Say what to change.');
			const image = validImage(input.image);
			const provider = input.provider ? rt.providerById(input.provider) : rt.provider('cad');
			const started = performance.now();
			// A background task: leaving the workbench does not lose the change; it waits in Activity.
			const task = rt.tasks.start(
				{
					kind: 'ai-edit',
					title: `${model.name}: ${input.instruction.trim().split('\n')[0].slice(0, 70)}`,
					projectId: model.projectId,
					modelId: id,
					provider: provider.id,
					stage: `Asking ${AI_PROVIDER_NAME[provider.id]}…`
				},
				(ctx) => editPart(provider, { ...input, image }, ctx.signal, ctx.stage),
				(result) => ({
					suggestion: {
						...result,
						provider: provider.id,
						seconds: Math.round((performance.now() - started) / 1000)
					}
				})
			);
			return json({ task }, { status: 202 });
		}
		default:
			throw new AppError(404, 'Unknown model action.');
	}
});
