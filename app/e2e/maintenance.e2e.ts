import { expect, test, type Page } from '@playwright/test';

// Waits until the app has hydrated, so handlers are live.
const ready = (page: Page) => page.locator('html[data-ready]').waitFor({ state: 'attached' });

test.beforeEach(async ({ context }) => {
	await context.addInitScript(() => sessionStorage.setItem('print-lab-profile', 'all'));
});

test('Maintenance: wiki tasks, add and mark done, earlier print hours, nozzle log', async ({
	page
}) => {
	const ws = await (await page.request.get('/api/workspace')).json();
	const x2d = ws.printers.find((p: { name: string }) => p.name === 'Bambu Lab X2D');
	expect(x2d).toBeTruthy();

	// The side panel on the printer page links to the full page.
	await page.goto(`/printers/${x2d.id}`);
	await ready(page);
	const panel = page.locator('[data-maintenance-panel]');
	await expect(panel).toContainText('print hours');
	const href = `/printers/${x2d.id}/maintenance`;
	await expect(panel.getByRole('link', { name: 'All maintenance' })).toHaveAttribute('href', href);
	await page.goto(href);
	await ready(page);

	// The X2D's tasks from the Bambu Lab wiki, each linking to its page.
	const tasks = page.locator('li[data-task]');
	await expect(page.locator('li[data-task="xy_axes"]')).toContainText('Every 60 days');
	await expect(page.locator('li[data-task="carbon_filter"]')).toContainText(
		'Every 1440 print hours'
	);
	await expect(
		page.locator('li[data-task="xy_axes"]').getByRole('link', { name: 'Bambu Lab wiki' })
	).toHaveAttribute('href', /wiki\.bambulab\.com\/en\/x2d\//);

	// A task of our own, then marked done: it goes in the log.
	const before = await tasks.count();
	await page.getByRole('button', { name: '＋ Add a task' }).click();
	await page.getByLabel('Task', { exact: true }).fill('Wipe the bed');
	await page.getByLabel('Every … days').fill('1');
	await page.getByRole('button', { name: 'Add task' }).click();
	await expect(tasks).toHaveCount(before + 1);
	const mine = tasks.filter({ hasText: 'Wipe the bed' });
	await expect(mine).toContainText('Due in 1 day');
	await mine.getByRole('button', { name: '✓ Done' }).click();
	const log = page.locator('.log li');
	await expect(log.filter({ hasText: 'Wipe the bed' })).toHaveCount(1);
	await expect(mine).toContainText(/last done (?!not yet)/);

	// Hours printed before the app.
	await page.getByRole('button', { name: 'Set earlier hours' }).click();
	await page.getByLabel('Hours before this app').fill('120');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByText('Includes 120.0 h from before.')).toBeVisible();

	// The X2D reads its nozzles itself: the change is only logged, never sent.
	await page.getByRole('button', { name: 'Log a nozzle change' }).click();
	await expect(page.getByText('Tell the printer too')).toHaveCount(0);
	await page.getByLabel('Diameter').selectOption('0.6');
	await page.getByRole('combobox', { name: /^Type/ }).selectOption('hardened_steel');
	await page.getByRole('button', { name: 'Log the change' }).click();
	await expect(log.filter({ hasText: 'Nozzle changed to 0.6 mm hardened steel' })).toHaveCount(1);
	// Earlier tests finish prints on this X2D, so the odometer is those hours plus the 120.
	const odo = (await (await page.request.get(`/api/printers/${x2d.id}/maintenance`)).json())
		.odometer;
	await expect(log.filter({ hasText: 'Nozzle changed' })).toContainText(
		`${odo.totalHours.toFixed(1)} h`
	);

	// Firmware: read-only facts and the wiki's release notes.
	await expect(
		page.getByRole('link', { name: 'Release notes on the Bambu Lab wiki' })
	).toHaveAttribute('href', /x2d\/manual\/X2D-firmware-release-history/);
});
