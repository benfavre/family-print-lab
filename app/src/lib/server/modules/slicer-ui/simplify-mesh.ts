import type { Soup } from '../../cad/mesh';
import { AppError } from '../../validation';
import { load, soupOf, toSolid } from './mesh-tools';

/** Manifold's tolerance-based simplification keeps original vertex coordinates; no centring/drop. */
export async function simplifyMesh(soup: Soup, tolerance: number): Promise<Soup | null> {
	if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance > 10_000)
		throw new AppError(400, 'Choose a positive simplification tolerance.');
	const w = await load();
	const original = toSolid(w, soup);
	try {
		// manifold-3d's Manifold.simplify contract: a subset of the original vertices, with surfaces
		// displaced by less than tolerance. Unlike setTolerance, it does not change future tolerances.
		const simplified = original.simplify(tolerance);
		try {
			const result = soupOf(simplified);
			if (!result.length || !result.every(Number.isFinite))
				throw new AppError(422, 'Simplifying would leave no usable mesh. Try a smaller tolerance.');
			return result.length < soup.length ? result : null;
		} finally {
			simplified.delete();
		}
	} finally {
		original.delete();
	}
}
