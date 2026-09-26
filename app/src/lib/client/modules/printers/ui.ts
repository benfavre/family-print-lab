// The foundation's own UI registrations: the printer page's panels, the "Add to shelf" tray action and
// the Printers and Backups settings sections. Packages register theirs the same way in their own ui.ts.
import { defineUi } from '../../registry';
import CurrentPrintPanel from '$lib/components/printers/CurrentPrintPanel.svelte';
import ReadyJobsPanel from '$lib/components/printers/ReadyJobsPanel.svelte';
import TemperaturesPanel from '$lib/components/printers/TemperaturesPanel.svelte';
import AmsView from '$lib/components/printers/AmsView.svelte';
import AlertsPanel from '$lib/components/printers/AlertsPanel.svelte';
import ConnectionPanel from '$lib/components/printers/ConnectionPanel.svelte';
import PrintersSection from '$lib/components/printers/PrintersSection.svelte';
import BackupsSection from '$lib/components/BackupsSection.svelte';

export default defineUi({
	key: 'printers',
	printerPanels: [
		{
			id: 'current-print',
			order: 10,
			column: 'main',
			title: 'Current print',
			component: CurrentPrintPanel
		},
		{
			id: 'ready-jobs',
			order: 20,
			column: 'main',
			title: 'Queued jobs ready to send',
			component: ReadyJobsPanel
		},
		{
			id: 'temperatures',
			order: 10,
			column: 'side',
			title: 'Temperatures',
			component: TemperaturesPanel
		},
		{ id: 'ams', order: 20, column: 'side', title: 'AMS', component: AmsView },
		{ id: 'alerts', order: 30, column: 'side', title: 'Alerts', component: AlertsPanel },
		{ id: 'connection', order: 40, column: 'side', title: 'Connection', component: ConnectionPanel }
	],
	trayActions: [
		{
			id: 'add-to-shelf',
			order: 90,
			label: '＋ Shelf',
			show: (tray) => !!tray.type,
			run: ({ tray, app }) =>
				app.ui.openEditor('spool', null, {
					material: tray.type,
					colorHex: tray.color ?? '#5ee7ff',
					remainingGrams: tray.remain !== null ? tray.remain * 10 : 1000,
					notes: `From the printer, tray ${tray.slot}`
				})
		}
	],
	settingsSections: [
		{ id: 'printers', order: 10, group: 'printers', title: 'Printers', component: PrintersSection },
		{ id: 'backups', order: 100, group: 'system', title: 'Backups', component: BackupsSection }
	]
});
