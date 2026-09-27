// lan-auth: the "Access from other devices" settings section, a Log out button for browsers that
// logged in, and a palette command for it.
import { defineUi } from '../../registry';
import AccessSection from '$lib/components/auth/AccessSection.svelte';
import LogoutButton from '$lib/components/auth/LogoutButton.svelte';
import { logOut } from '../../lan-auth';

export default defineUi({
	key: 'lan-auth',
	settingsSections: [
		{
			id: 'access',
			order: 10,
			group: 'privacy',
			title: 'Access from other devices',
			component: AccessSection
		}
	],
	topBarItems: [{ id: 'logout', order: 90, component: LogoutButton }],
	paletteCommands: [
		{
			id: 'logout',
			label: 'Log out of this device',
			keywords: 'sign out session login password',
			run: () => void logOut()
		}
	]
});
