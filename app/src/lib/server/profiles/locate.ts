// Where Bambu Studio's system presets are (a folder holding BBL.json and BBL/). First that exists:
//   1. the Print Lab Slicer engine's bundled resources (<resources>/profiles), same tag as the engine;
//   2. PRINTLAB_PROFILES_DIR (the folder itself, or one holding profiles/);
//   3. app/resources/bambu/profiles (bun run profiles:fetch; the desktop build copies resources/);
//   4. the stock Bambu Studio / OrcaSlicer install the command-line backend uses (today's behaviour).
import fs from 'node:fs';
import path from 'node:path';
import { locateCli, locateEngine, type SlicerHost } from '../slicer/locate';
import { UPSTREAM_PRINTERS } from '$lib/shared/printers/models.generated';
import type { VendorInfo } from '$lib/shared/slicer-profiles';

export interface ProfilesLocation {
	dir: string;
	source: VendorInfo['source'];
	/** The Bambu Studio tag the presets come from, when known. */
	tag: string;
}

const hasVendor = (dir: string) => fs.existsSync(path.join(dir, 'BBL.json'));

/** The tag written by profiles:fetch (upstream.json), else `fallback`. */
function stampedTag(dir: string, fallback: string) {
	try {
		const stamp = JSON.parse(fs.readFileSync(path.join(dir, 'upstream.json'), 'utf8')) as {
			tag?: unknown;
		};
		if (typeof stamp.tag === 'string' && stamp.tag) return stamp.tag;
	} catch {
		// no stamp
	}
	return fallback;
}

export function locateProfiles(
	env: Record<string, string | undefined> = process.env,
	cwd = process.cwd(),
	host?: SlicerHost
): ProfilesLocation | null {
	const engine = locateEngine(env, cwd, host);
	if (engine?.resourcesDir) {
		const dir = path.join(engine.resourcesDir, 'profiles');
		// The engine is built from the pinned tag, like the rest of the app's upstream data.
		if (hasVendor(dir))
			return { dir, source: 'engine', tag: stampedTag(dir, UPSTREAM_PRINTERS.tag) };
	}
	const custom = env.PRINTLAB_PROFILES_DIR;
	if (custom) {
		for (const dir of [path.resolve(cwd, custom), path.resolve(cwd, custom, 'profiles')])
			if (hasVendor(dir)) return { dir, source: 'env', tag: stampedTag(dir, 'unknown') };
	}
	const app = path.resolve(cwd, 'resources', 'bambu', 'profiles');
	if (hasVendor(app))
		return { dir: app, source: 'app', tag: stampedTag(app, UPSTREAM_PRINTERS.tag) };
	const cli = locateCli(env, cwd, host);
	if (cli?.resourcesDir) {
		const dir = path.join(cli.resourcesDir, 'profiles');
		const version = cli.path.match(/(?:bambu-studio|orca-slicer)-v?([\d.]+)/i)?.[1];
		if (hasVendor(dir))
			return { dir, source: 'cli', tag: stampedTag(dir, version ? `v${version}` : 'unknown') };
	}
	return null;
}
