// Statistics: the "Stats" section (between Filament and Family) and a palette command.
import { resolve } from '$app/paths';
import { defineUi } from '../../registry';
import { download } from '../../actions';
import { filterParams } from '$lib/shared/analytics';

export default defineUi({
	key: 'analytics',
	nav: [
		{
			id: 'analytics',
			order: 45,
			href: resolve('/analytics'),
			label: 'Stats',
			key: 'a',
			icon: 'M2.5 13.5h11M4 11V7.5M7 11V4.5M10 11V8M13 11V5.5',
			match: (p) => p.startsWith('/analytics')
		}
	],
	paletteCommands: [
		{
			id: 'analytics-export',
			label: 'Download every finished print (CSV)',
			keywords: 'stats analytics export spreadsheet filament cost',
			// Every finished print, dated in this computer's time zone like the page.
			run: () =>
				download(
					`/api/analytics/export.csv?${filterParams({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone })}`
				)
		}
	]
});
