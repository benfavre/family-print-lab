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
import { mergeUi } from './slots';

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
	/** Shown after the label; default 'Action'. */
	hint?: string;
	/** Extra search words, never shown. */
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

export { mergeUi } from './slots';

// Folders starting with "__" hold test fixtures and are left out.
const files = import.meta.glob<{ default: UiModule }>(
	['./modules/*/ui.ts', '!./modules/__*/ui.ts'],
	{
		eager: true
	}
);

export const UI: Slots = mergeUi(
	Object.values(files)
		.map((f) => f.default)
		.filter(Boolean),
	(message) => {
		if (import.meta.env.DEV) throw new Error(message);
		console.error(message);
	}
);
