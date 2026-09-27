// gcode-preview: the toolpath preview on job cards (a button that opens it) and in the send panel for
// the chosen plate.
import { defineUi } from '../../registry';
import GcodeJobPanel from '$lib/components/gcode/GcodeJobPanel.svelte';
import GcodeSendSection from '$lib/components/gcode/GcodeSendSection.svelte';

export default defineUi({
	key: 'gcode-preview',
	jobPanels: [
		{ id: 'toolpaths', order: 50, component: GcodeJobPanel, show: (job) => !!job.sliced }
	],
	sendPanelSections: [{ id: 'toolpaths', order: 50, component: GcodeSendSection }]
});
