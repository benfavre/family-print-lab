// The controls package's printer page: the Controls panel (speed, lights, temperatures, fans, motion,
// calibration, G-code), Skip objects while a print runs, Print checks, and Load / Unload on every tray.
// Kid mode never reaches the printer pages, so none of this shows there.
import { defineUi } from '../../registry';
import ControlsPanel from '$lib/components/controls/ControlsPanel.svelte';
import SkipObjectsPanel from '$lib/components/controls/SkipObjectsPanel.svelte';
import DetectorsPanel from '$lib/components/controls/DetectorsPanel.svelte';
import { trayLabel } from '$lib/shared/printing';
import { isActive } from '$lib/shared/controls';
import { runCommand } from './commands';

export default defineUi({
	key: 'controls',
	printerPanels: [
		{
			id: 'controls',
			order: 30,
			column: 'main',
			title: 'Controls',
			component: ControlsPanel
		},
		{
			id: 'skip-objects',
			order: 15,
			column: 'main',
			title: 'Skip objects',
			component: SkipObjectsPanel,
			show: (p) => p.state?.gcodeState === 'RUNNING' || p.state?.gcodeState === 'PAUSE'
		},
		{
			id: 'detectors',
			order: 35,
			column: 'side',
			title: 'Print checks',
			component: DetectorsPanel,
			show: (p) => !!p.connected
		}
	],
	trayActions: [
		{
			id: 'load',
			order: 10,
			label: 'Load',
			show: (tray, p) =>
				!!tray.type &&
				!tray.active &&
				!!p.connected &&
				!!p.caps?.amsSwitchCommand &&
				!isActive(p.state ?? null),
			run: async ({ tray, printer, app }) => {
				const dual = (printer.state?.nozzles.length ?? 1) > 1;
				if (
					!(await app.ui.ask(
						`Load ${tray.type} from ${trayLabel(tray.global, dual)}?`,
						'The printer heats the nozzle, pulls out the filament that is loaded now and feeds this one in.',
						'Load'
					))
				)
					return;
				await runCommand(
					app,
					printer,
					'print.ams_change_filament',
					{ tray: tray.global },
					'Loading filament…'
				);
			}
		},
		{
			id: 'unload',
			order: 11,
			label: 'Unload',
			show: (tray, p) =>
				tray.active && !!p.connected && !!p.caps?.amsSwitchCommand && !isActive(p.state ?? null),
			run: async ({ printer, app }) => {
				if (
					!(await app.ui.ask(
						'Unload the filament?',
						'The printer heats the nozzle and pulls the filament back out.',
						'Unload'
					))
				)
					return;
				await runCommand(app, printer, 'print.ams_change_filament:unload', {}, 'Unloading…');
			}
		}
	]
});
