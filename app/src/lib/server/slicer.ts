// Slicing inside the app now lives in slicer/: service.ts is what jobs call, engine.ts opens Print Lab
// Slicer or falls back to the stock command line (cli.ts), profile-book.ts flattens Bambu Studio's
// profiles for that command line. This file keeps the small helper other code used before.
import { locateCli, type SlicerHost } from './slicer/locate';
import { versionFromPath } from './slicer/cli';

export type { SliceChoice, SliceSettings } from './slicer/profile-book';

export interface SlicerInfo {
	available: boolean;
	path: string | null;
	version: string | null;
	/** Where its profiles live (<resourcesDir>/profiles/BBL). */
	resourcesDir: string | null;
}

/**
 * The stock Bambu Studio (or OrcaSlicer) command line, found by slicer/locate.ts: BAMBU_STUDIO_PATH,
 * ORCA_SLICER_PATH, then the usual install places on each platform.
 */
export function findSlicer(
	env: Record<string, string | undefined> = process.env,
	cwd?: string,
	host?: SlicerHost
): SlicerInfo {
	const found = locateCli(env, cwd, host);
	return {
		available: !!found,
		path: found?.path ?? null,
		version: found ? versionFromPath(found.path) : null,
		resourcesDir: found?.resourcesDir ?? null
	};
}
