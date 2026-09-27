import { expect, test, type Page } from '@playwright/test';

// Printer controls on the simulated X2D: lights, a temperature, the reasons shown for controls that
// cannot be used right now, the print checks, and the guarded custom G-code box.
const ready = (page: Page) => page.locator('html[data-ready]').waitFor({ state: 'attached' });

test.beforeEach(async ({ context }) => {
	await context.addInitScript(() => sessionStorage.setItem('print-lab-profile', 'all'));
});

test('Controls: light, bed temperature, reasons, print checks and custom G-code', async ({
	page
}) => {
	const ws = await page.request.get('/api/workspace').then((r) => r.json());
	const x2d = ws.printers.find((p: { serial: string }) => p.serial === 'SIM-X2D-0001');
	expect(x2d).toBeTruthy();
	await page.goto(`/printers/${x2d.id}`);
	await ready(page);
	const panel = page.locator('section.controls');
	await expect(panel.getByRole('heading', { name: 'Controls' })).toBeVisible();

	// Speed only changes while printing, and says so.
	await expect(panel.getByText('Speed can only change while printing.')).toBeVisible();
	await expect(panel.getByRole('button', { name: 'Sport' })).toBeDisabled();

	// The chamber light follows the printer's report.
	const light = panel.getByRole('button', { name: /^Chamber light:/ });
	const before = (await light.textContent())?.includes(': on') ? 'on' : 'off';
	await light.click();
	await expect(light).toHaveText(`Chamber light: ${before === 'on' ? 'off' : 'on'}`, {
		timeout: 15_000
	});

	// Bed target, through the X2D's set_bed_temp.
	await panel.getByLabel('Bed', { exact: true }).fill('45');
	await panel.getByLabel('Bed', { exact: true }).press('Enter');
	await expect(panel.locator('.temp-row', { hasText: 'Bed' })).toContainText('/ 45°', {
		timeout: 15_000
	});
	await panel.locator('.temp-row', { hasText: 'Bed' }).getByRole('button', { name: 'Off' }).click();

	// Extruding needs a hot nozzle.
	await expect(panel.getByRole('button', { name: 'Extrude' })).toBeDisabled();

	// Print checks the X2D reports.
	const checks = page.locator('section.panel', { hasText: 'Print checks' });
	await expect(checks.getByText('First layer check')).toBeVisible();

	// Custom G-code stays hidden until the grown-up says they know what they are doing.
	await panel.getByText('Custom G-code').click();
	await expect(panel.getByLabel('G-code lines')).toHaveCount(0);
	await panel.getByLabel('I know what I am doing').check();
	await panel.getByLabel('G-code lines').fill('M140 S40');
	await panel.getByRole('button', { name: 'Send', exact: true }).click();
	await page.getByRole('button', { name: 'Send G-code' }).click();
	await expect(panel.locator('.temp-row', { hasText: 'Bed' })).toContainText('/ 40°', {
		timeout: 15_000
	});
	await panel.locator('.temp-row', { hasText: 'Bed' }).getByRole('button', { name: 'Off' }).click();
});
