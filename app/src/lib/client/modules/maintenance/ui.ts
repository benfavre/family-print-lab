// The maintenance tracker's UI: a side panel on the printer page and the Maintenance sub-page link.
import { resolve } from '$app/paths';
import { defineUi } from '../../registry';
import MaintenancePanel from '$lib/components/maintenance/MaintenancePanel.svelte';

export default defineUi({
	key: 'maintenance',
	printerPanels: [
		{
			id: 'maintenance',
			order: 35,
			column: 'side',
			title: 'Maintenance',
			component: MaintenancePanel,
			show: (p) => !!p.id
		}
	],
	printerTabs: [
		{
			id: 'maintenance',
			order: 30,
			label: 'Maintenance',
			href: (id) => resolve('/printers/[id]/maintenance', { id })
		}
	]
});
