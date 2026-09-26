// A UI module the way a package writes one (test fixture; folders starting with "__" are not loaded).
import { defineUi } from '../../registry';
import HelloPanel from './HelloPanel.svelte';

export default defineUi({
	key: 'hello',
	nav: [
		{
			id: 'hello',
			order: 25,
			href: '/hello',
			label: 'Hello',
			key: 'h',
			icon: 'M3 8h10',
			match: (p) => p.startsWith('/hello')
		}
	],
	printerPanels: [{ id: 'hello', order: 15, column: 'main', title: 'Hello', component: HelloPanel }]
});
