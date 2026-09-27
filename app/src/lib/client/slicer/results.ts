// Reading the workspace's sliced plates: whether a plate's result still matches the project, totals,
// and the per-object breakdown when the engine reports one.
import type { Project } from '$lib/shared/slicer/project';
import type { PlateResult, ResultsView } from '$lib/shared/slicer-ui';

/** A plate's result, and whether edits since have made it stale. */
export function plateResult(
	view: ResultsView | null,
	plate: number,
	savedRevision: number | null
): { result: PlateResult; stale: boolean } | null {
	const result = view?.results.find((r) => r.plate === plate);
	if (!result) return null;
	return { result, stale: savedRevision === null || result.revision !== savedRevision };
}

export function totalGrams(r: PlateResult): number {
	return Math.round(r.stats.filaments.reduce((a, f) => a + f.grams, 0) * 10) / 10;
}

export interface ObjectRow {
	objectId: string;
	name: string;
	seconds: number | null;
	grams: number | null;
	/** Share of the plate's time, 0..1, when known. */
	share: number | null;
}

/** Per-object time and filament (Print Lab Slicer reports it; the command line does not). */
export function objectRows(project: Project, r: PlateResult): ObjectRow[] {
	const total = r.stats.seconds || null;
	return r.stats.objects.map((o) => ({
		objectId: o.objectId,
		name: project.objects.find((x) => x.id === o.objectId)?.name ?? o.objectId,
		seconds: o.seconds,
		grams: o.grams === null ? null : Math.round(o.grams * 10) / 10,
		share: o.seconds !== null && total ? Math.min(1, o.seconds / total) : null
	}));
}

/** Filaments the plate uses, with the project's slot colours. */
export function filamentRows(project: Project, r: PlateResult) {
	return r.stats.filaments
		.filter((f) => f.grams > 0 || f.meters > 0)
		.map((f) => {
			const slot = project.filaments.find((s) => s.index === f.index);
			return {
				index: f.index,
				color: slot?.color ?? '#888888',
				type: slot?.type ?? '',
				grams: Math.round(f.grams * 10) / 10,
				meters: Math.round(f.meters * 100) / 100
			};
		});
}
