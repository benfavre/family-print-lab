import { expect, test, type Page } from '@playwright/test';

// The Stats page against the e2e fixture (legacy-v1.json). Two finished jobs, worked out by hand:
//   j1 Desk cable dock  Failed     38 g PLA Matte on s1 (22 / 1000 g) = 0.836,  61 min
//   j3 Desk pen station Succeeded  96 g PETG on s2 (25 / 1000 g)      = 2.40,  176 min
// → 2 prints, 50% worked, 134 g, cost 3.24, 3h 57m printer time, 2h 56m average (successful only).
// The range ends before today so jobs other tests finish never count here.
const ready = (page: Page) => page.locator('html[data-ready]').waitFor({ state: 'attached' });
const range = 'from=2026-09-01&to=2026-09-25';

test.beforeEach(async ({ context }) => {
	await context.addInitScript(() => sessionStorage.setItem('print-lab-profile', 'all'));
});

test('Stats shows the fixture’s numbers and exports them as CSV', async ({ page }) => {
	await page.goto(`/analytics?${range}`);
	await ready(page);
	const tiles = page.getByRole('definition');
	const tile = (label: string) =>
		page.locator('.pipeline .stat', { has: page.getByRole('term').filter({ hasText: label }) });
	await expect(tile('Prints').locator('dd')).toHaveText('2');
	await expect(tile('Worked').locator('dd')).toHaveText('50%');
	await expect(tile('Filament').locator('dd')).toHaveText('134 g');
	await expect(tile('Cost').locator('dd')).toHaveText('3.24');
	await expect(tile('Printer time').locator('dd')).toHaveText('3h 57m');
	await expect(tile('Average print').locator('dd')).toHaveText('2h 56m');
	await expect(tiles).toHaveCount(6);

	await expect(page.getByRole('list', { name: 'Failure reasons' })).toContainText(
		'Warped corner, first layer too fast.'
	);
	await expect(page.locator('table.top tbody tr')).toHaveCount(2);
	await expect(page.getByRole('figure').filter({ hasText: 'PETG' }).first()).toBeVisible();

	// A person with no prints empties the view.
	await page.getByLabel('Person').selectOption({ label: 'Son' });
	await expect(tile('Prints').locator('dd')).toHaveText('0');
	await expect(page).toHaveURL(/person=son/);

	const res = await page.request.get(`/api/analytics/export.csv?${range}`);
	expect(res.headers()['content-type']).toMatch(/^text\/csv/);
	const lines = (await res.text()).replace(/^\ufeff/, '').split('\r\n');
	expect(lines[0]).toBe(
		'Finished,Project,Person,Printer,Result,Material,Filament (g),Filament cost,Printer time (min),Failure reason,Job id'
	);
	expect(lines.slice(1, 3)).toEqual([
		'2026-09-24 09:53,Desk cable dock,You,No printer set,Failed,PLA Matte,38,0.84,61,"Warped corner, first layer too fast.",j1',
		'2026-09-23 14:53,Desk pen station,You,No printer set,Succeeded,PETG,96,2.4,176,,j3'
	]);
});
