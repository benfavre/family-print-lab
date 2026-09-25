// Things a child makes in kid mode: each is a project owned by the child with one parametric model,
// so grown-ups can open it in the workbench, and the child can ask for it to be printed.
import { KID_LEVEL_LABEL } from '$lib/shared/domain';
import { plaGrams } from '$lib/shared/kid';
import { AppError } from '../validation';
import type { Runtime } from '../runtime';
import type { KidProfile } from './session';
import { renderKid, usableTemplate } from './templates';

export function needKid(kid: KidProfile | null): KidProfile {
	if (!kid) throw new AppError(403, 'Kid mode is not on in this browser.');
	return kid;
}

const choices = (input: unknown) =>
	input && typeof input === 'object' && !Array.isArray(input)
		? (input as Record<string, unknown>)
		: {};

export async function previewThing(kid: KidProfile, templateId: unknown, params: unknown) {
	const r = await renderKid(String(templateId), kid.kid, choices(params), kid.name);
	return { params: r.params, size: r.size, grams: plaGrams(r.volume), soup: r.soup };
}

export async function makeThing(
	rt: Runtime,
	kid: KidProfile,
	templateId: unknown,
	params: unknown
) {
	const template = usableTemplate(String(templateId), kid.kid);
	const r = await renderKid(template.id, kid.kid, choices(params), kid.name);
	const text = template.controls.find((c) => c.kind === 'text');
	const title = text ? `${template.title}: ${r.params[text.name]}` : template.title;
	const projectId = rt.lab.createProject({
		profileId: kid.id,
		title: title.slice(0, 80),
		category: 'Creative',
		description: `${template.blurb} Made in kid mode (${KID_LEVEL_LABEL[kid.kid].toLowerCase()}).`,
		checklist: []
	});
	try {
		const model = rt.models.createRendered(projectId, template.title, r.soup, {
			source: r.source,
			params: r.params,
			note: `Made by ${kid.name}`,
			origin: `kid:${template.id}`
		});
		return { projectId, modelId: model.id, versionId: model.versionId };
	} catch (error) {
		rt.lab.deleteProject(projectId);
		throw error;
	}
}
