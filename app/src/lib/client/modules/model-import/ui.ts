// model-import: the drop target over the whole app and the import windows, a top-bar button, a
// palette command and the Integrations section for the Thingiverse token.
import { defineUi } from '../../registry';
import ImportOverlay from '$lib/components/import/ImportOverlay.svelte';
import ImportButton from '$lib/components/import/ImportButton.svelte';
import ImportSettings from '$lib/components/import/ImportSettings.svelte';
import { importWindows } from '$lib/components/import/state.svelte';

export default defineUi({
	key: 'model-import',
	globalOverlays: [{ id: 'model-import', order: 50, component: ImportOverlay }],
	topBarItems: [{ id: 'model-import', order: 50, component: ImportButton }],
	paletteCommands: [
		{
			id: 'model-import',
			label: 'Import a model from a link (Printables, Thingiverse, MakerWorld)',
			keywords: 'Action',
			run: () => importWindows.openLink()
		}
	],
	settingsSections: [
		{
			id: 'model-links',
			order: 40,
			group: 'integrations',
			title: 'Model links',
			component: ImportSettings
		}
	]
});
