// Home automation in the UI: the Integrations section (plugs, MQTT, Home Assistant, metrics) and the
// printer page's Power panel.
import { defineUi } from '../../registry';
import HomeAutomationSection from '$lib/components/home-automation/HomeAutomationSection.svelte';
import PowerPanel from '$lib/components/home-automation/PowerPanel.svelte';

export default defineUi({
	key: 'home-automation',
	printerPanels: [
		{ id: 'power', order: 35, column: 'side', title: 'Power', component: PowerPanel }
	],
	settingsSections: [
		{
			id: 'home-automation',
			order: 50,
			group: 'integrations',
			title: 'Home automation',
			component: HomeAutomationSection
		}
	]
});
