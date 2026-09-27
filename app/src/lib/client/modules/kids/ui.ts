// The kids package's UI: the parent's dashboard on the Family page and a palette command for the
// family gallery. Kid-mode sections are on the kid pages themselves.
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { defineUi } from '../../registry';
import KidsDashboard from '$lib/components/kids/KidsDashboard.svelte';

export default defineUi({
	key: 'kids',
	familyPanels: [{ id: 'kids-dashboard', order: 10, component: KidsDashboard }],
	paletteCommands: [
		{
			id: 'family-gallery',
			label: 'Open the family gallery',
			keywords: 'photos kids badges certificate',
			run: () => void goto(resolve('/family/gallery'))
		}
	]
});
