// Notifications: the bell in the top bar, the settings section on Integrations and a palette command.
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { defineUi } from '../../registry';
import NotificationBell from '$lib/components/notifications/NotificationBell.svelte';
import NotificationsSection from '$lib/components/notifications/NotificationsSection.svelte';

export default defineUi({
	key: 'notifications',
	topBarItems: [{ id: 'notifications', order: 10, component: NotificationBell }],
	settingsSections: [
		{
			id: 'notifications',
			order: 10,
			group: 'notifications',
			title: 'Notifications',
			component: NotificationsSection
		}
	],
	paletteCommands: [
		{
			id: 'notification-settings',
			label: 'Notification settings',
			keywords: 'notify ntfy discord telegram email webhook alerts bell',
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() plus a hash
			run: () => void goto(`${resolve('/integrations')}#notifications`)
		}
	]
});
