// Merging UI registrations per slot (pure; used by registry.ts and nav.ts, and tested on its own).
import type { SlotEntry, Slots, UiModule } from './registry';

const SLOTS = [
	'nav',
	'printerPanels',
	'printerTabs',
	'trayActions',
	'settingsSections',
	'jobPanels',
	'sendPanelSections',
	'spoolFormFields',
	'familyPanels',
	'topBarItems',
	'globalOverlays',
	'paletteCommands'
] as const satisfies readonly (keyof Slots)[];

/** Merges modules per slot: replacements first, then duplicate checks, then sort by order. */
export function mergeUi(modules: UiModule[], onError: (message: string) => void): Slots {
	const out = {} as Record<string, unknown[]>;
	for (const slot of SLOTS) {
		const entries = modules.flatMap((m) =>
			((m[slot] ?? []) as (SlotEntry & { order?: number })[]).map((e) => ({ e, key: m.key }))
		);
		const replaced = new Set(entries.map((x) => x.e.replaces).filter(Boolean));
		const kept = entries.filter((x) => !replaced.has(x.e.id));
		const seen = new Map<string, string>();
		const unique = kept.filter(({ e, key }) => {
			const before = seen.get(e.id);
			if (before) {
				onError(`UI slot ${slot}: “${e.id}” is registered by both ${before} and ${key}.`);
				return false;
			}
			seen.set(e.id, key);
			return true;
		});
		out[slot] = unique.map((x) => x.e).sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
	}
	return out as unknown as Slots;
}
