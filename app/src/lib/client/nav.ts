// The app's sections, shared by the top bar, the mobile tab bar and the "G then …" shortcuts.
import { resolve } from '$app/paths';

export interface NavItem {
	href: string;
	label: string;
	/** Second key after G to jump here. */
	key: string;
	/** 16×16 stroke icon path. */
	icon: string;
	match: (path: string) => boolean;
}

export const NAV: NavItem[] = [
	{
		href: resolve('/'),
		label: 'Projects',
		key: 'p',
		icon: 'M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z',
		match: (p) => p === '/' || p.startsWith('/projects')
	},
	{
		href: resolve('/jobs'),
		label: 'Print jobs',
		key: 'j',
		icon: 'M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01',
		match: (p) => p.startsWith('/jobs')
	},
	{
		href: resolve('/printer'),
		label: 'Printer',
		key: 'r',
		icon: 'M2.5 2.5h11v11h-11zM2.5 5.5h11M6 9.5h4M8 5.5v4',
		match: (p) => p.startsWith('/printer')
	},
	{
		href: resolve('/filament'),
		label: 'Filament',
		key: 'f',
		icon: 'M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11zM8 6.2a1.8 1.8 0 1 0 0 3.6a1.8 1.8 0 1 0 0-3.6z',
		match: (p) => p.startsWith('/filament')
	},
	{
		href: resolve('/family'),
		label: 'Family',
		key: 'm',
		icon: 'M5.5 7a2 2 0 1 0 0-4a2 2 0 1 0 0 4zM11 7.5a1.7 1.7 0 1 0 0-3.4a1.7 1.7 0 1 0 0 3.4zM1.8 13c.4-2.4 1.9-3.8 3.7-3.8s3.3 1.4 3.7 3.8M9.6 9.6c.4-.2.9-.3 1.4-.3 1.6 0 2.8 1.2 3.2 3.2',
		match: (p) => p.startsWith('/family')
	},
	{
		href: resolve('/shop'),
		label: 'Shop',
		key: 's',
		icon: 'M3 5.5h10l-.8 8H3.8zM5.5 5.5V4.5a2.5 2.5 0 0 1 5 0v1',
		match: (p) => p.startsWith('/shop')
	}
];

export const INTEGRATIONS_NAV: NavItem = {
	href: resolve('/integrations'),
	label: 'Integrations',
	key: 'i',
	icon: 'M6 2.5v3M10 2.5v3M4.5 5.5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11.5v2',
	match: (p) => p.startsWith('/integrations')
};
