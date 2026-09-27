// onboarding: a palette command for the setup guide. The guide opens by itself on a brand new lab
// (FirstRunGate in the profile chooser) and from the Integrations page header.
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { defineUi } from '../../registry';

export default defineUi({
	key: 'onboarding',
	paletteCommands: [
		{
			id: 'setup-guide',
			label: 'Open the setup guide',
			keywords: 'welcome onboarding first run printer family start',
			run: () => void goto(resolve('/welcome'))
		}
	]
});
