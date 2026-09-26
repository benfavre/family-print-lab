// Profile resolution API (slicer-profiles implements ProfileService): Bambu Studio system presets
// (resources/profiles/BBL at the tag in slicer/upstream.lock) plus user presets, resolved exactly as
// Bambu Studio's PresetBundle does. Types only; the foundation writes no profile code.
import type { ModelCode } from '../printers/models';
import type { ConfigMap, ConfigValue, PresetRef, PresetSelection } from './project';

/** Bambu Studio preset folders: machine/, process/, filament/. */
export type PresetKind = 'printer' | 'process' | 'filament';

export interface PresetSummary {
	kind: PresetKind;
	name: string;
	source: 'system' | 'user';
	/** system: the name; user: the database id. */
	id: string;
	inherits: string | null;
	/** instantiation !== "false". */
	instantiable: boolean;
	/** compatible_printers. */
	compatiblePrinters: string[];
	/** compatible_printers_condition. */
	compatibleCondition: string | null;
	/** Printer presets: printer_model. */
	printerModel?: string;
	/** Printer presets: nozzle_diameter. */
	nozzle?: string;
	/** Filament presets: filament_type[0]. */
	filamentType?: string;
	/** Filament presets: filament_id (e.g. "GFA00"). */
	filamentId?: string;
	settingId?: string;
}

export interface UserPreset {
	id: string;
	kind: PresetKind;
	name: string;
	inherits: string | null;
	/** Only the keys that differ from the parent. */
	config: ConfigMap;
	updatedAt: string;
}

export interface ResolvedPreset {
	kind: PresetKind;
	name: string;
	/** From the preset itself up to the root. */
	chain: string[];
	config: ConfigMap;
	/** For each key, the preset name that set it. */
	origin: Record<string, string>;
}

export interface ResolvedBundle {
	printer: ResolvedPreset;
	process: ResolvedPreset;
	filaments: ResolvedPreset[];
	/** The flat config the slicer consumes (printer + process + per-filament arrays combined as upstream does). */
	full: ConfigMap;
	vendor: { tag: string; version: string };
}

export interface ProfileService {
	vendor(): { tag: string; version: string; dir: string } | null;
	list(
		kind: PresetKind,
		filter?: { printer?: string; model?: ModelCode; nozzle?: string; includeHidden?: boolean }
	): PresetSummary[];
	resolve(ref: PresetRef): ResolvedPreset;
	diff(ref: PresetRef): { key: string; value: ConfigValue; parent: ConfigValue | null }[];
	compatible(printer: PresetRef, kind: 'process' | 'filament'): PresetSummary[];
	/** Default printer/process/filament presets for a printer model, nozzle and material ("PLA", "PETG HF"…). */
	defaults(model: ModelCode, nozzle: string, material?: string): PresetSelection;
	bundle(
		selection: PresetSelection,
		overrides?: { process?: ConfigMap; filaments?: ConfigMap[]; printer?: ConfigMap }
	): ResolvedBundle;
}
