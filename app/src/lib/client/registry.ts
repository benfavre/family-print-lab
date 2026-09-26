// The UI registry: how feature packages add navigation, printer panels, settings sections and other
// pieces without editing the pages. Each package adds src/lib/client/modules/<key>/ui.ts exporting
// `defineUi({...})` as default; everything is gathered here (import.meta.glob, eager), merged per slot
// and sorted by `order`. An entry with `replaces: '<id>'` removes the entry with that id from the same
// slot (the hms package replaces the basic "Alerts" panel, for example); otherwise two entries with
// the same id in one slot are an error (thrown in development, logged in production).
import type { Component } from 'svelte';
import type { NavItem } from './nav';
import type { AppContext } from './app.svelte';
import type { Job, Spool } from '$lib/shared/domain';
import type { PrinterStatus, PrinterTray } from '$lib/shared/printers/status';
import type { PrinterInfo } from '$lib/shared/printers/info';

/** Every slot entry has an id, an order and optionally the id of an entry it replaces. */
export interface SlotEntry {
	id: string;
	order: number;
	replaces?: string;
}
export interface PrinterPanel extends SlotEntry {
	title: string;
	column: 'main' | 'side';
	component: Component<{ printer: PrinterStatus; info: PrinterInfo }>;
	show?: (printer: PrinterStatus) => boolean;
}
export interface PrinterTab extends SlotEntry {
	label: string;
	/** e.g. (id) => `/printers/${id}/alerts`; the route belongs to the registering package. */
	href: (printerId: string) => string;
	show?: (printer: PrinterStatus) => boolean;
}
export interface TrayAction extends SlotEntry {
	label: string;
	show?: (tray: PrinterTray, printer: PrinterStatus) => boolean;
	run: (ctx: {
		tray: PrinterTray;
		printer: PrinterStatus;
		app: AppContext;
	}) => void | Promise<void>;
}
export interface SettingsSection extends SlotEntry {
	title: string;
	group:
		'printers' | 'printing' | 'integrations' | 'notifications' | 'family' | 'privacy' | 'system';
	component: Component<Record<string, never>>;
}
export interface JobPanel extends SlotEntry {
	component: Component<{ job: Job }>;
	show?: (job: Job) => boolean;
}
export interface SendSection extends SlotEntry {
	component: Component<{ job: Job; printerId: string | null; plate: number }>;
}
export interface SpoolField extends SlotEntry {
	component: Component<{ spool: Spool | null; draft: Record<string, unknown> }>;
}
export interface SlotComponent extends SlotEntry {
	component: Component<Record<string, never>>;
}
export interface PaletteCommand {
	id: string;
	label: string;
	keywords?: string;
	run: (app: AppContext) => void;
}

export interface UiModule {
	key: string;
	/** Base order: Projects 10, Print jobs 20, Printers 30, Filament 40, Family 50, Shop 60. */
	nav?: (NavItem & SlotEntry)[];
	printerPanels?: PrinterPanel[];
	/** Links to a printer's sub-pages (Alerts, Media, Maintenance, AI checks…) shown under the printer hero. */
	printerTabs?: PrinterTab[];
	trayActions?: TrayAction[];
	settingsSections?: SettingsSection[];
	jobPanels?: JobPanel[];
	sendPanelSections?: SendSection[];
	spoolFormFields?: SpoolField[];
	familyPanels?: SlotComponent[];
	topBarItems?: SlotComponent[];
	globalOverlays?: SlotComponent[];
	paletteCommands?: PaletteCommand[];
}
export type Slots = { [K in keyof Omit<UiModule, 'key'>]-?: NonNullable<UiModule[K]> };

export function defineUi(m: UiModule): UiModule {
	return m;
}

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

const files = import.meta.glob<{ default: UiModule }>('./modules/*/ui.ts', { eager: true });

export const UI: Slots = mergeUi(
	Object.values(files)
		.map((f) => f.default)
		.filter(Boolean),
	(message) => {
		if (import.meta.env.DEV) throw new Error(message);
		console.error(message);
	}
);
