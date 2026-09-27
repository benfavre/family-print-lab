// The camera package's UI: the Camera panel on the printer page, the Media sub-page link and the
// Cameras section in Integrations.
import { resolve } from '$app/paths';
import { defineUi } from '../../registry';
import CameraPanel from '$lib/components/camera/CameraPanel.svelte';
import CameraSettings from '$lib/components/camera/CameraSettings.svelte';

export default defineUi({
	key: 'camera',
	printerPanels: [
		{ id: 'camera', order: 5, column: 'main', title: 'Camera', component: CameraPanel }
	],
	printerTabs: [
		{
			id: 'media',
			order: 20,
			label: 'Media',
			href: (id) => resolve('/printers/[id]/media', { id })
		}
	],
	settingsSections: [
		{ id: 'cameras', order: 20, group: 'printers', title: 'Cameras', component: CameraSettings }
	]
});
