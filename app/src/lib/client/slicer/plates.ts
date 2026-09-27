// Where plates stand in project coordinates. Bambu Studio lays plates out in a grid, one plate plus a
// fifth of a plate apart (PartPlate.hpp compute_colum_count, PartPlate.cpp LOGICAL_PART_PLATE_GAP),
// and an instance belongs to the plate it stands on; both backends use the same layout (cli.ts
// plateOrigin, the engine's facade/upstream/model_io.cpp plate_origin), so positions set here slice
// where they are shown.
import type { Project } from '$lib/shared/slicer/project';
import type { BedShape } from '$lib/shared/slicer-ui';
import { translate } from './matrix';

/** Plates per row for a plate count (compute_colum_count). */
export function plateColumns(plates: number): number {
	const value = Math.sqrt(Math.max(1, plates));
	const round = Math.round(value);
	return value > round ? round + 1 : round;
}

/** A plate's origin (the bed's 0,0 on it) in project coordinates. */
export function plateOrigin(bed: BedShape, plates: number, index: number): [number, number] {
	const [minX, minY, maxX, maxY] = bed.area;
	const cols = plateColumns(plates);
	const i = Math.max(0, index - 1);
	return [(i % cols) * (maxX - minX) * 1.2, 0 - Math.floor(i / cols) * (maxY - minY) * 1.2];
}

/** The middle of a plate's printable area in project coordinates. */
export function plateCentre(bed: BedShape, plates: number, index: number): [number, number] {
	const [ox, oy] = plateOrigin(bed, plates, index);
	return [ox + (bed.area[0] + bed.area[2]) / 2, oy + (bed.area[1] + bed.area[3]) / 2];
}

/** The plate whose area (plus the gap around it) holds a point, or null outside every plate. */
export function plateAt(bed: BedShape, plates: number, x: number, y: number): number | null {
	const w = bed.area[2] - bed.area[0],
		h = bed.area[3] - bed.area[1];
	for (let index = 1; index <= plates; index++) {
		const [ox, oy] = plateOrigin(bed, plates, index);
		const x0 = ox + bed.area[0] - w * 0.1,
			y0 = oy + bed.area[1] - h * 0.1;
		if (x >= x0 && x < x0 + w * 1.2 && y >= y0 && y < y0 + h * 1.2) return index;
	}
	return null;
}

/** Which plate an instance is on (the project's plate lists), or null. */
export function plateOf(project: Project, objectId: string, instanceId: string): number | null {
	return (
		project.plates.find((p) =>
			p.instances.some((i) => i.objectId === objectId && i.instanceId === instanceId)
		)?.index ?? null
	);
}

/**
 * Moves every instance with its plate after the plate count changed from `before` (adding or removing
 * a plate can change the grid, so plates move; their contents go with them).
 */
export function relayout(
	project: Project,
	bed: BedShape,
	before: number,
	renumber = new Map<number, number>()
) {
	const after = project.plates.length;
	for (const plate of project.plates) {
		const old = [...renumber.entries()].find(([, now]) => now === plate.index)?.[0] ?? plate.index;
		const [ax, ay] = plateOrigin(bed, before, old);
		const [bx, by] = plateOrigin(bed, after, plate.index);
		if (ax === bx && ay === by) continue;
		for (const ref of plate.instances) {
			const inst = project.objects
				.find((o) => o.id === ref.objectId)
				?.instances.find((i) => i.id === ref.instanceId);
			if (inst) inst.transform = translate(inst.transform, bx - ax, by - ay);
		}
	}
}
