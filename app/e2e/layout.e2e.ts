import { expect, test } from '@playwright/test';

// The top bar keeps every action on screen, however many sections and top-bar items packages add.
test.beforeEach(async ({ context }) => {
	await context.addInitScript(() => sessionStorage.setItem('print-lab-profile', 'all'));
});

for (const width of [360, 390, 1024, 1280, 1440])
	test(`the top bar fits at ${width} px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 800 });
		await page.goto('/');
		await page.locator('html[data-ready]').waitFor({ state: 'attached' });
		const bar = page.locator('.topbar');
		const size = await bar.evaluate((e) => ({ scroll: e.scrollWidth, client: e.clientWidth }));
		expect(size.scroll).toBeLessThanOrEqual(size.client);
		const menu = page.getByRole('button', { name: /^Menu/ });
		const box = (await menu.boundingBox())!;
		expect(box.x + box.width).toBeLessThanOrEqual(width);
		const search = (await page
			.getByRole('button', { name: /^Search and commands/ })
			.boundingBox())!;
		expect(search.width).toBeGreaterThanOrEqual(32);
		if (width > 700) {
			// Sections that do not fit are one click away.
			const views = await page
				.locator('.views')
				.evaluate((e) => ({ scroll: e.scrollWidth, client: e.clientWidth }));
			expect(views.scroll).toBeLessThanOrEqual(views.client);
			await page.getByRole('button', { name: /^More sections/ }).click();
			await page.getByRole('menuitem', { name: 'Slicer projects' }).click();
			await expect(page).toHaveURL(/\/slicer/);
		}
	});
