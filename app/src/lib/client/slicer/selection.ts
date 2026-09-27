// What is selected in the workspace: objects (each with the instance that was clicked) and at most one
// part of a single selected object, like Bambu Studio's object list.
import type { Project } from '$lib/shared/slicer/project';
import { plateOf } from './plates';

export interface Pick {
	objectId: string;
	instanceId: string;
}
export interface Selection {
	items: Pick[];
	/** A part of the only selected object. */
	partId: string | null;
}

export const EMPTY_SELECTION: Selection = { items: [], partId: null };

/** A click on an instance: alone, or added/removed with Shift or Ctrl. */
export function clickPick(sel: Selection, pick: Pick | null, additive: boolean): Selection {
	if (!pick) return additive ? sel : EMPTY_SELECTION;
	const has = sel.items.some((i) => i.objectId === pick.objectId);
	if (!additive) return { items: [pick], partId: null };
	return {
		items: has ? sel.items.filter((i) => i.objectId !== pick.objectId) : [...sel.items, pick],
		partId: null
	};
}

/** Selects a part (its object alone becomes selected). */
export function pickPart(project: Project, objectId: string, partId: string | null): Selection {
	const obj = project.objects.find((o) => o.id === objectId);
	if (!obj) return EMPTY_SELECTION;
	const part = partId && obj.parts.some((p) => p.id === partId) ? partId : null;
	return { items: [{ objectId, instanceId: obj.instances[0]?.id ?? '' }], partId: part };
}

/** Every instance on a plate (Ctrl+A). */
export function selectPlate(project: Project, plate: number): Selection {
	const p = project.plates.find((x) => x.index === plate);
	const seen = new Set<string>();
	const items: Pick[] = [];
	for (const ref of p?.instances ?? [])
		if (!seen.has(ref.objectId)) {
			seen.add(ref.objectId);
			items.push({ objectId: ref.objectId, instanceId: ref.instanceId });
		}
	return { items, partId: null };
}

/** The selection without what no longer exists (after undo, delete or a reload). */
export function pruneSelection(project: Project, sel: Selection): Selection {
	const items = sel.items.filter((i) =>
		project.objects.some(
			(o) => o.id === i.objectId && o.instances.some((x) => x.id === i.instanceId)
		)
	);
	const only = items.length === 1 ? project.objects.find((o) => o.id === items[0].objectId) : null;
	const partId =
		only && sel.partId && only.parts.some((p) => p.id === sel.partId) ? sel.partId : null;
	return items.length === sel.items.length && partId === sel.partId ? sel : { items, partId };
}

/** The plates the selection stands on. */
export function selectedPlates(project: Project, sel: Selection): number[] {
	return [
		...new Set(
			sel.items
				.map((i) => plateOf(project, i.objectId, i.instanceId))
				.filter((p): p is number => p !== null)
		)
	].sort((a, b) => a - b);
}
