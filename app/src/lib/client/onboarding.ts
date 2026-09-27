// Presentation shared by the Integrations page and the setup guide: which group each integration
// belongs to, where its settings are, and the Print Lab Cloud link shown as one more card.
import type { IntegrationStatus } from '$lib/shared/integrations';
import type { CloudStatus } from '$lib/shared/cloud';
import type { PrinterInfo } from '$lib/shared/printers/info';

export type IntegrationGroup = 'ai' | 'making' | 'printers' | 'home' | 'more';

export const INTEGRATION_GROUPS: { id: IntegrationGroup; title: string; lead: string }[] = [
	{
		id: 'ai',
		title: 'AI',
		lead: 'Subscriptions run through the official command-line tools, signed in on this computer, with every tool and file access switched off, so they can only answer. Keep the app for your own family’s use.'
	},
	{
		id: 'making',
		title: 'Making and slicing',
		lead: 'Design, repair and slice on this computer.'
	},
	{
		id: 'printers',
		title: 'Printers',
		lead: 'Everything the app reads from and sends to your printers, on your home network.'
	},
	{
		id: 'home',
		title: 'Alerts, home and phone',
		lead: 'Where the lab tells you things. Each one is off until you set it up.'
	},
	{ id: 'more', title: 'More', lead: 'Added by other parts of the app.' }
];

const GROUP_OF: Record<string, IntegrationGroup> = {
	openscad: 'making',
	blender: 'making',
	slicer: 'making',
	'slicer-profiles': 'making',
	'model-import': 'making',
	printer: 'printers',
	camera: 'printers',
	hms: 'printers',
	spoolman: 'printers',
	notifications: 'home',
	'home-automation': 'home',
	cloud: 'home'
};

export function integrationGroup(item: Pick<IntegrationStatus, 'id' | 'kind'>): IntegrationGroup {
	if (item.kind === 'ai') return 'ai';
	return GROUP_OF[item.id] ?? (item.kind === 'printer' ? 'printers' : 'more');
}

/** Items per group, in the page's group order, keeping each group's incoming order; empty groups are left out. */
export function groupIntegrations(
	items: IntegrationStatus[]
): { id: IntegrationGroup; title: string; lead: string; items: IntegrationStatus[] }[] {
	return INTEGRATION_GROUPS.map((g) => ({
		...g,
		items: items.filter((i) => integrationGroup(i) === g.id)
	})).filter((g) => g.items.length);
}

/** The Settings section (registry id) where an integration is set up, when it has one. */
export const SETTINGS_SECTION: Record<string, string> = {
	printer: 'printers',
	camera: 'cameras',
	spoolman: 'spoolman',
	notifications: 'notifications',
	'home-automation': 'home-automation',
	'slicer-profiles': 'slicer-profiles',
	'model-import': 'model-links'
};

/** The DOM id the Integrations page gives a registered settings section. */
export const settingsAnchor = (sectionId: string) => `settings-${sectionId}`;

/** Print Lab Cloud as an Integrations card (it is part of the app, not a module, so it has no row). */
export function cloudIntegration(cloud: CloudStatus): IntegrationStatus {
	const linked = !!cloud.account && cloud.state !== 'unlinked' && cloud.state !== 'pairing';
	return {
		id: 'cloud',
		kind: 'module',
		name: 'Print Lab Cloud',
		via: 'Optional, end-to-end encrypted, for your phone',
		available: linked && cloud.state === 'online',
		detail: !cloud.configured
			? 'This copy of the app has no cloud address, so nothing ever leaves this computer.'
			: linked
				? `Linked to ${cloud.account}${cloud.state === 'online' ? '' : ' (offline, retrying)'}.`
				: cloud.state === 'pairing'
					? 'Waiting for the code to be entered on your phone.'
					: 'Not linked. Nothing leaves this computer until you link it.',
		version: null,
		powers: [
			'Kids ask to print from a phone',
			'Answer requests away from home',
			'Encrypted backups (Family plan)'
		],
		setup: cloud.configured
			? [{ text: 'Family page: set a parent PIN, then press Link to Print Lab Cloud.' }]
			: []
	};
}

/**
 * One line about how the app trusts a printer's certificate, or null before it has connected.
 * A pinned certificate is remembered on first use (PLAN 4.2.3), so the app warns if it ever changes.
 */
export function trustLine(info: Pick<PrinterInfo, 'trust' | 'tls' | 'simulated'>): string | null {
	if (info.simulated) return 'This is the simulator, so there is no certificate to check.';
	if (!info.tls) return 'Encryption is off for this printer, so its identity is not checked.';
	if (info.trust === 'ca')
		return 'The printer’s certificate was verified as a genuine Bambu Lab one.';
	if (info.trust === 'pinned')
		return 'The app remembered this printer’s certificate and will warn you if it ever changes.';
	return null;
}
