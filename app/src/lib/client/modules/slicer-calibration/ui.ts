// Calibration's UI registrations: the Calibrate section, the printer's Calibration sub-page link and
// a palette command.
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { defineUi } from '../../registry';

export default defineUi({
	key: 'slicer-calibration',
	nav: [
		{
			id: 'calibration',
			order: 42,
			href: resolve('/calibration'),
			label: 'Calibrate',
			key: 'c',
			icon: 'M3 13.5V9M3 6.5v-4M8 13.5V11M8 8.5v-6M13 13.5V7M13 4.5v-2M1.5 9h3M6.5 8.5h3M11.5 4.5h3',
			match: (p) => p.startsWith('/calibration')
		}
	],
	printerTabs: [
		{
			id: 'calibration',
			order: 40,
			label: 'Calibration',
			href: (id) => resolve('/printers/[id]/calibration', { id })
		}
	],
	paletteCommands: [
		{
			id: 'calibrate',
			label: 'Calibrate a filament',
			keywords: 'flow rate pressure advance temperature tower retraction',
			run: () => void goto(resolve('/calibration'))
		}
	]
});
