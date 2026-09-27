// The AI check's UI: a side panel on the printer page, the AI checks sub-page link and the settings
// section in Integrations.
import { resolve } from '$app/paths';
import { defineUi } from '../../registry';
import VisionPanel from '$lib/components/vision/VisionPanel.svelte';
import VisionSettings from '$lib/components/vision/VisionSettings.svelte';

export default defineUi({
	key: 'ai-vision',
	printerPanels: [
		{
			id: 'ai-vision',
			order: 25,
			column: 'side',
			title: 'AI check',
			component: VisionPanel,
			show: (p) => !!p.id && p.camera !== 'none'
		}
	],
	printerTabs: [
		{
			id: 'ai-vision',
			order: 25,
			label: 'AI checks',
			href: (id) => resolve('/printers/[id]/vision', { id }),
			show: (p) => p.camera !== 'none'
		}
	],
	settingsSections: [
		{
			id: 'ai-vision',
			order: 30,
			group: 'printing',
			title: 'AI print checks',
			component: VisionSettings
		}
	]
});
