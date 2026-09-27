// The queue's UI registrations: the Queue section, the printer page's "Up next", the send panel's
// "Add to queue" and the quiet hours settings.
import { resolve } from '$app/paths';
import { defineUi } from '../../registry';
import UpNextPanel from '$lib/components/queue/UpNextPanel.svelte';
import AddToQueueSection from '$lib/components/queue/AddToQueueSection.svelte';
import QueueSettings from '$lib/components/queue/QueueSettings.svelte';

export default defineUi({
	key: 'queue',
	nav: [
		{
			id: 'queue',
			order: 25,
			href: resolve('/queue'),
			label: 'Queue',
			key: 'q',
			icon: 'M2.5 3.5h11M2.5 7h11M2.5 10.5h6M11 9.5l2.5 2-2.5 2',
			match: (p) => p.startsWith('/queue')
		}
	],
	printerPanels: [
		{ id: 'up-next', order: 15, column: 'main', title: 'Up next', component: UpNextPanel }
	],
	sendPanelSections: [{ id: 'add-to-queue', order: 50, component: AddToQueueSection }],
	settingsSections: [
		{ id: 'queue', order: 20, group: 'printing', title: 'Print queue', component: QueueSettings }
	]
});
