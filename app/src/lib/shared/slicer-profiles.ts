// Types the slicer-profiles package shares between its API and its UI (Settings → Slicer profiles, the
// job's Slicer settings panel, the spool's filament preset). The profile API itself is in
// shared/slicer/profiles.ts.
import type { ConfigMap, ConfigValue, PresetRef, PresetSelection } from './slicer/project';
import type { PresetKind, PresetSummary, ResolvedPreset, UserPreset } from './slicer/profiles';
import type { ModelCode } from './printers/models';

/** A job's slicer settings (jobs.slice_overrides): chosen presets and per-job key overrides. */
export interface JobSliceSettings {
	/** Presets picked for this job; anything left out comes from the defaults for its printer. */
	printer?: PresetRef | null;
	process?: PresetRef | null;
	filaments?: PresetRef[] | null;
	/** Keys changed for this job only, on top of the presets. */
	overrides?: { printer?: ConfigMap; process?: ConfigMap; filaments?: ConfigMap[] };
}

/** Where the system presets came from. */
export interface VendorInfo {
	tag: string;
	version: string;
	dir: string;
	source: 'engine' | 'env' | 'app' | 'cli';
}

/** A printer model as the profiles know it. */
export interface ProfileModel {
	code: ModelCode;
	name: string;
	short: string;
	/** Nozzle sizes with a system printer preset. */
	nozzles: string[];
	hasCover: boolean;
}

/** GET /api/slicer/profiles */
export interface ProfilesOverview {
	vendor: VendorInfo | null;
	/** Why there are no system presets, in plain words. */
	missing: string | null;
	models: ProfileModel[];
	users: UserPreset[];
}

/** One key of a preset in the editor. */
export interface PresetKey {
	key: string;
	value: ConfigValue;
	/** The parent's value, when the preset changes it. */
	parent: ConfigValue | null;
	/** The preset that set it. */
	origin: string;
	changed: boolean;
}

/** Keys grouped like Bambu Studio's parameter tabs; keys the tabs do not show go under "Other". */
export interface PresetPage {
	page: string;
	groups: { group: string; keys: PresetKey[] }[];
}

/** GET /api/slicer/profiles/preset */
export interface PresetDetail {
	preset: ResolvedPreset;
	summary: PresetSummary | null;
	user: UserPreset | null;
	pages: PresetPage[];
}

/** GET /api/slicer/presets/jobs/[id]: what a job slices with. */
export interface JobSliceView {
	settings: JobSliceSettings;
	/** The presets the job resolves to (its choices, else the defaults). */
	selection: PresetSelection | null;
	model: ModelCode;
	nozzle: string;
	/** Presets the job may pick from, for its printer. */
	processes: PresetSummary[];
	filaments: PresetSummary[];
	/** Why presets are unavailable, if they are. */
	error: string | null;
}

export type { PresetKind };
