import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// Waits until the app has hydrated, so handlers are live.
const ready = (page: Page) => page.locator('html[data-ready]').waitFor({ state: 'attached' });
const workspace = (page: Page) => page.request.get('/api/workspace').then((r) => r.json());

test.beforeEach(async ({ context }) => {
	await context.addInitScript(() => sessionStorage.setItem('print-lab-profile', 'all'));
});

test('Integrations → Printers: find, test, add, edit, reorder, switch off, diagnostics and remove', async ({
	page
}) => {
	await page.goto('/integrations');
	await ready(page);
	const section = page.locator('#printers');
	const rows = section.locator('li[data-printer]');
	// The simulated X2D came from the BAMBU_* settings (imported once on first start).
	await expect(rows).toHaveCount(1);
	await expect(rows.first()).toContainText('SIM-X2D-0001');

	// A second simulated printer announces itself on the network.
	await section.getByRole('button', { name: 'Find printers' }).click();
	const found = section.locator('.found li', { hasText: 'SIM-P1S-0001' });
	await expect(found).toBeVisible({ timeout: 20_000 });
	await found.getByRole('button', { name: 'Add' }).click();
	const form = page.getByRole('dialog', { name: 'Add a printer' });
	await expect(form.getByLabel('IP address')).toHaveValue('127.0.0.1');
	await expect(form.getByLabel('Serial number')).toHaveValue('SIM-P1S-0001');
	await form.getByLabel('Access code').fill('12345678');
	await form.getByRole('button', { name: 'Show advanced settings' }).click();
	await form.getByLabel('MQTT port').fill('18841');
	await form.getByLabel('File port').fill('19001');
	await form.getByLabel('Encrypted (TLS)').uncheck();
	await form.getByLabel('This is the printer simulator').check();
	await form.getByRole('button', { name: 'Test the connection' }).click();
	await expect(form.locator('.result')).toContainText('Connected', { timeout: 15_000 });
	await expect(form.locator('.result')).toContainText('P1S');
	await form.getByRole('button', { name: 'Add printer' }).click();
	await expect(rows).toHaveCount(2);
	const p1s = rows.filter({ hasText: 'SIM-P1S-0001' });
	await expect(p1s).toContainText('Idle', { timeout: 15_000 });

	// The access code is write-only: never sent back to the browser.
	await p1s.getByRole('button', { name: 'Edit' }).click();
	const edit = page.getByRole('dialog', { name: /^Edit / });
	await expect(edit.getByLabel('Access code')).toHaveValue('');
	await expect(edit.getByLabel('Access code')).toHaveAttribute(
		'placeholder',
		'Leave empty to keep'
	);
	await edit.getByLabel('Name', { exact: true }).fill('Garage P1S');
	await edit.getByRole('button', { name: 'Save changes' }).click();
	await expect(p1s).toContainText('Garage P1S');
	const ws = await workspace(page);
	expect(JSON.stringify(ws)).not.toContain('12345678');
	expect(ws.printers.map((p: { name: string }) => p.name)).toEqual(['Bambu Lab X2D', 'Garage P1S']);

	// Both are live on the printers overview.
	await page.goto('/printers');
	await expect(page.locator('.printer-card')).toHaveCount(2);
	await expect(page.locator('.printer-card', { hasText: 'Garage P1S' })).toContainText('Idle');

	// Reorder with the keyboard, then switch the P1S off: the first switched-on printer leads.
	await page.goto('/integrations');
	await ready(page);
	await p1s.getByRole('button', { name: /Move Garage P1S/ }).press('Alt+ArrowUp');
	await expect.poll(async () => (await workspace(page)).printers[0].name).toBe('Garage P1S');
	await p1s.getByRole('checkbox', { name: 'Garage P1S switched on' }).uncheck();
	await expect(p1s).toContainText('Switched off');
	await page.goto('/printer');
	await expect(page.getByRole('heading', { name: 'Bambu Lab X2D' })).toBeVisible();

	// Diagnostics: the last report without serial numbers or addresses.
	await page.goto('/integrations');
	await ready(page);
	const x2d = rows.filter({ hasText: 'SIM-X2D-0001' });
	const download = page.waitForEvent('download');
	await x2d.getByRole('link', { name: 'Download diagnostics' }).click();
	const text = fs.readFileSync((await (await download).path())!, 'utf8');
	const diagnostics = JSON.parse(text);
	expect(diagnostics).toMatchObject({ model: 'N6' });
	expect(diagnostics.pushall.gcode_state).toBeTruthy();
	expect(text).not.toContain('SIM-X2D-0001');

	// Remove the P1S again.
	await p1s.getByRole('button', { name: 'Remove' }).click();
	await page.getByRole('button', { name: 'Remove printer' }).click();
	await expect(rows).toHaveCount(1);
});
