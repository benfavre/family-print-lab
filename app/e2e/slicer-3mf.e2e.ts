import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Waits until the app has hydrated, so handlers are live.
const ready = (page: Page) => page.locator('html[data-ready]').waitFor({ state: 'attached' });
const FIXTURES = path.resolve('src/lib/server/slicer3mf/__fixtures__');

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ context }) => {
	await context.addInitScript(() => sessionStorage.setItem('print-lab-profile', 'all'));
});

test('Slicer projects: import a Bambu Studio project, look inside, download and delete it', async ({
	page
}) => {
	await page.goto('/slicer-projects');
	await ready(page);
	await page.getByLabel('Imports and new slicer projects go to').selectOption({
		label: 'Desk cable dock'
	});
	await page
		.locator('input[type=file][accept=".3mf,.stl,.obj"]')
		.setInputFiles(path.join(FIXTURES, 'synth-bambu-features.3mf'));
	const row = page.locator('li[data-slicer-project]', { hasText: 'synth-bambu-features' });
	await expect(row).toBeVisible();
	await expect(row).toContainText('2 objects · 2 plates');

	await row.getByRole('link', { name: /synth-bambu-features/ }).click();
	await expect(page.getByRole('heading', { name: 'synth-bambu-features' })).toBeVisible();
	const plates = page.getByRole('region', { name: 'Plates' });
	await expect(plates).toContainText('Plate 2: Second & last');
	await expect(plates).toContainText('Textured PEI Plate · One object at a time · Nozzles 1 2 1');
	await expect(page.getByRole('region', { name: 'Summary' })).toContainText('Painted supports');
	const objects = page.getByRole('region', { name: 'Objects' });
	await expect(objects).toContainText('Painted cube');
	await expect(objects).toContainText('Support blocker');
	await expect(page.getByRole('region', { name: 'Printer and filaments' })).toContainText(
		'Bambu Lab H2D 0.4 nozzle'
	);

	// "Open in Bambu Studio" hands over the file itself, unchanged since nothing was edited.
	const downloading = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Open in Bambu Studio' }).click();
	const file = await downloading;
	expect(file.suggestedFilename()).toBe('synth-bambu-features.3mf');
	const saved = await file.path();
	expect(
		fs.readFileSync(saved).equals(fs.readFileSync(path.join(FIXTURES, 'synth-bambu-features.3mf')))
	).toBe(true);

	// Renamed in place; the file keeps its own title.
	await page.getByRole('button', { name: 'synth-bambu-features' }).click();
	await page.getByLabel('Project name').fill('Plate test');
	await page.getByLabel('Project name').press('Enter');
	await expect(page.getByRole('heading', { name: 'Plate test' })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Summary' })).toContainText('Every feature');

	await page.getByRole('button', { name: 'Delete' }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
	await expect(page).toHaveURL(/\/slicer-projects$/);
	await expect(page.locator('li[data-slicer-project]', { hasText: 'Plate test' })).toHaveCount(0);
});

test('Slicer projects: start one from a model of the project', async ({ page }) => {
	// A mesh model in the project to put on the plate.
	const stl = fs.readFileSync(path.join(FIXTURES, 'bambu-test-buchse.3mf'));
	const upload = await page.request.post(
		'/api/models/upload?projectId=idea-02&name=Sorting%20bin&format=3mf',
		{ data: stl, headers: { 'content-type': 'application/octet-stream' } }
	);
	expect(upload.ok()).toBe(true);

	await page.goto('/slicer-projects');
	await ready(page);
	await page.getByLabel('Imports and new slicer projects go to').selectOption({
		label: 'Adapter sorting tray'
	});
	await page.getByRole('button', { name: '＋ From models' }).click();
	await page.getByLabel('Sorting bin').check();
	await page.getByRole('button', { name: 'Start slicer project' }).click();
	// A new slicer project opens in the slicer workspace (slicer-ui).
	await expect(page).toHaveURL(/\/projects\/idea-02\/slicer\/[\w-]+$/);
	await expect(page.getByRole('heading', { name: 'Sorting bin' })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Objects on this plate' })).toContainText(
		'Sorting bin'
	);
});
