// slicer-3mf: the Slicer projects section (Bambu Studio project files per project).
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { defineUi } from '../../registry';

export default defineUi({
	key: 'slicer-3mf',
	nav: [
		{
			id: 'slicer-projects',
			order: 70,
			href: resolve('/slicer-projects'),
			label: 'Slicer projects',
			key: 'l',
			icon: 'M2.5 12.5h11M4 10l4-7.5 4 7.5M5.5 7.5h5',
			match: (p) => p.startsWith('/slicer-projects')
		}
	],
	paletteCommands: [
		{
			id: 'slicer-projects',
			label: 'Slicer projects: import or open a Bambu Studio project',
			keywords: '3mf bambu studio orcaslicer slicer plate',
			run: () => void goto(resolve('/slicer-projects'))
		}
	]
});
