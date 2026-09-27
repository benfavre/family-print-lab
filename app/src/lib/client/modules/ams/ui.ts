// The ams package's UI: the printer's AMS panel (replacing the foundation's AmsView), an RFID-aware
// "Add to Filament" tray action, the spool editor's AMS facts and the Spoolman settings.
import { defineUi } from '../../registry';
import AmsPanel from '$lib/components/ams/AmsPanel.svelte';
import SpoolAmsFields from '$lib/components/ams/SpoolAmsFields.svelte';
import SpoolmanSection from '$lib/components/ams/SpoolmanSection.svelte';
import { amsLinks } from '$lib/components/ams/links.svelte';
import type { AmsState } from '$lib/shared/ams';

export default defineUi({
	key: 'ams',
	printerPanels: [
		{
			id: 'ams-sync',
			replaces: 'ams',
			order: 20,
			column: 'side',
			title: 'AMS',
			component: AmsPanel
		}
	],
	trayActions: [
		{
			id: 'ams-add',
			replaces: 'add-to-shelf',
			order: 90,
			label: '＋ Filament',
			show: (tray, printer) => !!tray.type && !amsLinks.link(printer.id ?? '', tray.global),
			run: async ({ tray, printer, app }) =>
				amsLinks.adopt(
					await app.lab.call<AmsState>(
						'POST',
						`/api/printers/${printer.id}/ams/add`,
						{ tray: tray.global },
						'Added to the Filament shelf.'
					)
				)
		}
	],
	spoolFormFields: [{ id: 'ams-spool', order: 50, component: SpoolAmsFields }],
	settingsSections: [
		{
			id: 'spoolman',
			order: 50,
			group: 'integrations',
			title: 'Spoolman',
			component: SpoolmanSection
		}
	]
});
