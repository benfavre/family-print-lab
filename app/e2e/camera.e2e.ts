import { expect, test, type Page } from '@playwright/test';

// The camera package on the simulated X2D: live view on the printer page, snapshots, the Media page
// with the simulator's timelapses, and camera pictures on the printer cards.
const ready = (page: Page) => page.locator('html[data-ready]').waitFor({ state: 'attached' });
const workspace = (page: Page) => page.request.get('/api/workspace').then((r) => r.json());

test.beforeEach(async ({ context }) => {
	await context.addInitScript(() => sessionStorage.setItem('print-lab-profile', 'all'));
});

test('the printer page shows the live camera, and the Media page lists timelapses', async ({
	page
}) => {
	const ws = await workspace(page);
	const x2d = ws.printers.find((p: { serial: string }) => p.serial === 'SIM-X2D-0001');
	await page.goto(`/printers/${x2d.id}`);
	await ready(page);
	const panel = page.getByRole('region', { name: 'Camera' });
	const img = panel.locator('.view img');
	await expect(img).toBeVisible({ timeout: 15_000 });
	await expect
		.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth), { timeout: 15_000 })
		.toBeGreaterThan(0);
	await expect(panel.getByText('LIVE')).toBeVisible();

	const snap = await page.request.get(`/api/printers/${x2d.id}/camera/snapshot.jpg`);
	expect(snap.status()).toBe(200);
	expect(snap.headers()['content-type']).toBe('image/jpeg');

	// Timelapse switch: sends ipcam_timelapse and follows the printer's report.
	const timelapse = panel.getByLabel('Record a timelapse of every print');
	await expect(timelapse).not.toBeChecked();
	await timelapse.check();
	await expect(timelapse).toBeChecked({ timeout: 10_000 });
	await timelapse.uncheck();
	await expect(timelapse).not.toBeChecked({ timeout: 10_000 });

	await page
		.getByRole('navigation', { name: /pages$/ })
		.getByRole('link', { name: 'Media' })
		.click();
	await expect(page).toHaveURL(new RegExp(`/printers/${x2d.id}/media$`));
	const items = page.locator('.media li.item[data-kind="video"]');
	await expect(items).toHaveCount(2, { timeout: 15_000 });
	const download = page.waitForEvent('download');
	await items.first().getByRole('button', { name: 'Download' }).click();
	expect((await download).suggestedFilename()).toMatch(/^video_.*\.mp4$/);
	await items
		.first()
		.getByRole('button', { name: /^Play / })
		.click();
	await expect(items.first().locator('video')).toBeVisible();

	await page.getByRole('button', { name: 'All files' }).click();
	await expect(page.locator('.media li.item.dir', { hasText: 'timelapse' })).toBeVisible();
});

test('printer cards show a camera picture once it is switched on', async ({ page }) => {
	await page.goto('/printers');
	await ready(page);
	await expect(page.locator('img.camera-thumb')).toHaveCount(0);
	await page.goto('/integrations');
	await ready(page);
	const saved = page.waitForResponse(
		(r) => r.url().endsWith('/api/camera/settings') && r.request().method() === 'PUT'
	);
	await page.getByLabel(/Show camera on printer cards/).check();
	expect((await saved).ok()).toBe(true);
	await page.goto('/printers');
	await ready(page);
	await expect(page.locator('img.camera-thumb').first()).toBeVisible({ timeout: 15_000 });
	// Back to the default for the other tests.
	await page.request.put('/api/camera/settings', { data: { showOnCards: false } });
});
