import { expect, test, type Page } from '@playwright/test';

// The AMS panel against the simulated X2D: a Bambu RFID spool goes onto the shelf with one click and
// shows where it is loaded, a tray gets new settings, and the AMS 2 Pro dries filament. Everything it
// changes on the shared simulator is put back at the end, for the other specs.
const SIM = 'http://127.0.0.1:18661';
const ready = (page: Page) => page.locator('html[data-ready]').waitFor({ state: 'attached' });

test.beforeEach(async ({ context }) => {
	await context.addInitScript(() => sessionStorage.setItem('print-lab-profile', 'all'));
});

test('AMS: add an RFID spool to the shelf, change a tray, dry filament', async ({ page }) => {
	// An AMS HT with a Bambu PETG HF spool (RFID) is plugged into the simulated X2D.
	const plugged = await page.request.post(`${SIM}/api/feature`, {
		data: { feature: 'ams', control: 'ams-add-ht' }
	});
	expect(plugged.ok()).toBe(true);

	await page.goto('/printer');
	await ready(page);
	const panel = page.locator('[data-panel="ams"]');
	const ht = panel.locator('button[data-tray="128"]');
	await expect(ht).toContainText('PETG', { timeout: 15_000 });
	await expect(ht).toContainText('Not on the shelf');

	// One click puts it on the shelf, linked to the tray.
	await ht.click();
	const dialog = page.getByRole('dialog', { name: 'PETG HF' });
	await expect(dialog).toContainText('A Bambu spool that is not on your shelf yet.');
	await dialog.getByRole('button', { name: '＋ Add to Filament' }).click();
	await expect(dialog).toContainText('On the shelf as');
	await expect(dialog.getByRole('button', { name: 'Settings' })).toBeDisabled();
	await dialog.getByRole('button', { name: 'Close' }).click();
	await expect(ht).not.toContainText('Not on the shelf');

	await page.goto('/filament');
	const card = page.locator('.spool-card', { hasText: 'Bambu Lab · PETG' });
	await expect(card).toContainText('Loaded in');
	await expect(card).toContainText('HT1');

	// A third-party spool's tray takes new settings from the app.
	await page.goto('/printer');
	await ready(page);
	await panel.locator('button[data-tray="2"]').click();
	const tray = page.locator('dialog#ams-tray');
	await tray.getByRole('button', { name: 'Settings' }).click();
	await tray.getByLabel('Material').selectOption('PETG');
	await tray.getByRole('button', { name: 'Send to printer' }).click();
	await expect(page.locator('.toast', { hasText: 'Sent to the printer.' })).toBeVisible();
	await expect(panel.locator('button[data-tray="2"]')).toContainText('PETG', { timeout: 10_000 });
	// Back as it was.
	await tray.getByRole('button', { name: 'Settings' }).click();
	await tray.getByLabel('Material').selectOption('PLA');
	await tray.getByLabel('Colour').fill('#ffffff');
	await tray.getByRole('button', { name: 'Send to printer' }).click();
	await expect(panel.locator('button[data-tray="2"]')).toContainText('PLA', { timeout: 10_000 });
	await tray.getByRole('button', { name: 'Close' }).click();

	// The AMS 2 Pro dries filament and can be stopped.
	const unit = panel.locator('[data-ams="0"]');
	await unit.getByRole('button', { name: 'Dry…' }).click();
	const dry = page.getByRole('dialog', { name: 'AMS 2 Pro 1' });
	await expect(dry.getByLabel('Temperature (°C)')).toHaveAttribute('max', '65');
	await dry.getByRole('button', { name: 'Start drying' }).click();
	await expect(unit).toContainText(/Drying at \d+ °C/, { timeout: 10_000 });
	await unit.getByRole('button', { name: 'Stop drying' }).click();
	await expect(unit).toContainText('Not drying', { timeout: 10_000 });

	// Tidy up for the other specs: the new spool leaves the shelf.
	const ws = await (await page.request.get('/api/workspace')).json();
	const added = ws.spools.find((s: { brand: string; material: string }) => s.brand === 'Bambu Lab');
	expect(added).toBeTruthy();
	expect((await page.request.delete(`/api/spools/${added.id}`)).ok()).toBe(true);
});
