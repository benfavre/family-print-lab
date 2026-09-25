import { expect, test } from '@playwright/test';

test('choose a maker, refresh, lock, and switch without losing a draft', async ({ page }) => {
	await page.goto('/');
	const workspace = await page.request.get('/api/workspace').then((r) => r.json());
	await expect(page.getByRole('heading', { name: 'Who’s making today?' })).toBeVisible();
	await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);
	await page.keyboard.press('n');
	await page.keyboard.press('Control+k');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await page.getByRole('button', { name: 'Continue as Son', exact: true }).click();
	await expect(page.locator('.idea-card')).toHaveCount(
		workspace.projects.filter((p: { profileId: string }) => p.profileId === 'son').length
	);
	await expect(page.locator('.profile-switcher')).toContainText('Son');
	await page.reload();
	await expect(page.locator('.profile-switcher')).toContainText('Son');
	await page.getByRole('button', { name: '＋ New idea' }).click();
	await page.getByLabel('Project name').fill('A draft to keep');
	await page.getByRole('button', { name: 'Lock screen or switch profile' }).click();
	await expect(page.getByRole('heading', { name: 'Who’s making today?' })).toBeVisible();
	await expect(page.getByLabel('Project name')).toBeHidden();
	await page.keyboard.press('Control+k');
	await page.keyboard.press('n');
	await page.getByRole('button', { name: 'Continue as Son', exact: true }).click();
	await expect(page.getByLabel('Project name')).toHaveValue('A draft to keep');
	await page.getByRole('button', { name: 'Lock screen or switch profile' }).click();
	await page.reload();
	await expect(page.getByRole('heading', { name: 'Who’s making today?' })).toBeVisible();
	await page.getByRole('button', { name: 'Continue as Everyone' }).click();
	await expect(page.locator('.idea-card')).toHaveCount(workspace.projects.length);
});

test('entry preserves deep links and profile management is reachable', async ({ page }) => {
	await page.goto('/projects/idea-09');
	await page.getByRole('button', { name: 'Continue as Son', exact: true }).click();
	await expect(page).toHaveURL(/\/projects\/idea-09$/);
	await expect(
		page.getByRole('heading', { level: 1, name: 'Mission control pencil cup' })
	).toBeVisible();
	await page.getByRole('button', { name: 'Lock screen or switch profile' }).click();
	await page.getByRole('button', { name: 'Continue as Daughter', exact: true }).click();
	await expect(page).toHaveURL(/\/$/);
	await expect(page.locator('.profile-switcher')).toContainText('Daughter');
	await page.getByRole('button', { name: 'Lock screen or switch profile' }).click();
	await page.getByRole('button', { name: 'Manage profiles' }).click();
	await expect(page).toHaveURL(/\/family$/);
	await expect(page.getByRole('button', { name: /Add person/ })).toBeVisible();
});

test('the new-idea shortcut waits for a profile and opens only one draft', async ({ page }) => {
	await page.goto('/?new=idea');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await page.getByRole('button', { name: 'Continue as Son', exact: true }).click();
	await expect(page.getByRole('dialog', { name: /A new idea/ })).toHaveCount(1);
	await expect(page).toHaveURL(/\/$/);
	await page.getByRole('button', { name: 'Lock screen or switch profile' }).click();
	await page.getByRole('button', { name: 'Continue as Son', exact: true }).click();
	await expect(page.getByRole('dialog', { name: /A new idea/ })).toHaveCount(1);
});

test('invalid saved profiles and blocked storage still allow entry on mobile', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.addInitScript(() => sessionStorage.setItem('print-lab-profile', 'deleted-profile'));
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'Who’s making today?' })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
	await page.screenshot({ path: 'test-results/profile-selector-mobile.png', fullPage: true });
	await page.evaluate(() => {
		Storage.prototype.setItem = () => {
			throw new Error('Storage blocked');
		};
		Storage.prototype.removeItem = () => {
			throw new Error('Storage blocked');
		};
	});
	await page.getByRole('button', { name: 'Continue as Everyone' }).focus();
	await page.keyboard.press('Enter');
	await expect(page.locator('.profile-switcher')).toContainText('Everyone');
	await page.getByRole('button', { name: 'Lock screen or switch profile' }).click();
	await expect(page.getByRole('heading', { name: 'Who’s making today?' })).toBeVisible();
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.screenshot({ path: 'test-results/profile-selector-desktop.png', fullPage: true });
});
