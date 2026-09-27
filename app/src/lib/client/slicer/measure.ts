// Measurements use project coordinates, after both the part and instance transforms (millimetres).
import type { Vec3 } from './matrix';

export function addMeasurePoint(points: readonly Vec3[], point: Vec3): Vec3[] {
	if (!point.every(Number.isFinite)) return [...points];
	return points.length === 1 ? [[...points[0]], [...point]] : [[...point]];
}

export function measure(points: readonly Vec3[]): { distance: number; delta: Vec3 } | null {
	if (points.length !== 2 || points.some((p) => !p.every(Number.isFinite))) return null;
	const delta = points[1].map((n, i) => n - points[0][i]) as Vec3;
	return { distance: Math.hypot(...delta), delta };
}
