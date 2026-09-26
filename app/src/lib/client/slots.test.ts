import { describe, expect, it } from 'vitest';
import type { Component } from 'svelte';
import { mergeUi } from './slots';
import hello from './modules/__test__/ui';
import type { UiModule } from './registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stub = (() => {}) as unknown as Component<any>;
const base: UiModule = {
	key: 'printers',
	nav: [
		{
			id: 'projects',
			order: 10,
			href: '/',
			label: 'Projects',
			key: 'p',
			icon: '',
			match: () => false
		},
		{
			id: 'printers',
			order: 30,
			href: '/printers',
			label: 'Printers',
			key: 'r',
			icon: '',
			match: () => false
		}
	],
	printerPanels: [
		{ id: 'current-print', order: 10, column: 'main', title: 'Current print', component: stub },
		{ id: 'alerts', order: 30, column: 'side', title: 'Alerts', component: stub }
	]
};

describe('UI registry', () => {
	it('a package ui.ts adds a nav item and a printer panel, placed by order', () => {
		const ui = mergeUi([base, hello], (m) => {
			throw new Error(m);
		});
		expect(ui.nav.map((n) => n.label)).toEqual(['Projects', 'Hello', 'Printers']);
		expect(ui.printerPanels.map((p) => p.id)).toEqual(['current-print', 'hello', 'alerts']);
		expect(ui.jobPanels).toEqual([]);
	});

	it('replaces an entry by id, and reports duplicate ids', () => {
		const hms: UiModule = {
			key: 'hms',
			printerPanels: [
				{
					id: 'hms-alerts',
					replaces: 'alerts',
					order: 30,
					column: 'side',
					title: 'Alerts',
					component: stub
				}
			]
		};
		expect(mergeUi([base, hms], () => {}).printerPanels.map((p) => p.id)).toEqual([
			'current-print',
			'hms-alerts'
		]);
		const errors: string[] = [];
		const twice = mergeUi(
			[base, { key: 'other', printerPanels: [{ ...base.printerPanels![0] }] }],
			(m) => errors.push(m)
		);
		expect(twice.printerPanels).toHaveLength(2);
		expect(errors[0]).toMatch(/current-print.*printers and other/);
	});
});
