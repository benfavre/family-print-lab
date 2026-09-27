// hms UI: the plain-words Alerts panel (replacing the foundation's code list), a banner when the last
// print failed with an error, the error on failed job cards, and the printer's Alerts page.
import { defineUi } from '../../registry';
import HmsAlertsPanel from '$lib/components/hms/HmsAlertsPanel.svelte';
import PrintErrorBanner from '$lib/components/hms/PrintErrorBanner.svelte';
import JobErrors from '$lib/components/hms/JobErrors.svelte';
import HmsSettings from '$lib/components/hms/HmsSettings.svelte';
import { resolve } from '$app/paths';

/** Print errors that mean "cancelled" (printer/diff.ts CANCEL_ERRORS): not worth a banner. */
const CANCELLED = new Set([0x0300400c, 0x0500400e]);

export default defineUi({
	key: 'hms',
	settingsSections: [
		{ id: 'hms', order: 40, group: 'printing', title: 'Printer error help', component: HmsSettings }
	],
	printerPanels: [
		{
			id: 'hms-alerts',
			replaces: 'alerts',
			order: 30,
			column: 'side',
			title: 'Alerts',
			component: HmsAlertsPanel
		},
		{
			id: 'hms-print-failed',
			order: 5,
			column: 'main',
			title: 'The last print failed',
			component: PrintErrorBanner,
			show: (p) =>
				p.state?.gcodeState === 'FAILED' &&
				!!p.state.printError &&
				!CANCELLED.has(p.state.printError)
		}
	],
	printerTabs: [
		{
			id: 'hms-alerts',
			order: 10,
			label: 'Alerts',
			href: (id) => resolve('/printers/[id]/alerts', { id })
		}
	],
	jobPanels: [
		{
			id: 'hms-job-error',
			order: 50,
			component: JobErrors,
			show: (job) => job.status === 'Failed'
		}
	]
});
