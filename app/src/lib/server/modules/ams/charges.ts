// Which spool pays for which filament of a finished print: the job's dispatch says which tray fed each
// filament (amsMapping, entry i = filament i + 1), the sliced plate says how many grams each took,
// and the tray links say which spool was in each tray. Pure, so the maths is tested on its own.
import type { JobDispatch, SlicedFilament } from '$lib/shared/domain';
import { EXT_MAIN, type GlobalTray } from '$lib/shared/printers/status';

export interface PlannedCharge {
	spoolId: string;
	tray: GlobalTray;
	grams: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * One charge per linked tray the plate used, scaled by `fraction` (1 for a finished print, the
 * progress for a failed one). A print sent without the AMS on a single-nozzle printer has an empty
 * mapping and feeds from the external spool. Filaments whose tray has no linked spool are skipped.
 */
export function planCharges(o: {
	filaments: SlicedFilament[];
	dispatch: Pick<JobDispatch, 'amsMapping' | 'useAms'>;
	links: Map<GlobalTray, string>;
	fraction: number;
}): PlannedCharge[] {
	const fraction = Math.min(1, Math.max(0, Number.isFinite(o.fraction) ? o.fraction : 1));
	const byTray = new Map<GlobalTray, PlannedCharge>();
	for (const f of o.filaments) {
		const tray: GlobalTray | undefined =
			!o.dispatch.useAms && !o.dispatch.amsMapping.length
				? EXT_MAIN
				: o.dispatch.amsMapping[f.id - 1];
		if (tray === undefined || tray < 0) continue;
		const spoolId = o.links.get(tray);
		if (!spoolId || !(f.grams > 0)) continue;
		const prev = byTray.get(tray);
		const grams = f.grams * fraction;
		if (prev) prev.grams += grams;
		else byTray.set(tray, { spoolId, tray, grams });
	}
	return [...byTray.values()]
		.map((c) => ({ ...c, grams: round1(c.grams) }))
		.filter((c) => c.grams > 0);
}

/** How far a failed print got, 0–1 (layers first, then percent); 1 when nothing says. */
export function progressFraction(o: {
	layer?: number | null;
	totalLayers?: number | null;
	percent?: number | null;
}): number {
	if (o.layer && o.totalLayers && o.totalLayers > 0)
		return Math.min(1, Math.max(0, o.layer / o.totalLayers));
	if (o.percent !== null && o.percent !== undefined && Number.isFinite(o.percent))
		return Math.min(1, Math.max(0, o.percent / 100));
	return 1;
}
