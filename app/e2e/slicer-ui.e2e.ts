import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Waits until the app has hydrated, so handlers are live.
const ready = (page: Page) => page.locator('html[data-ready]').waitFor({ state: 'attached' });
const FIXTURES = path.resolve('src/lib/server/slicer3mf/__fixtures__');

test.beforeEach(async ({ context }) => {
	await context.addInitScript(() => sessionStorage.setItem('print-lab-profile', 'all'));
});

test('the slicer workspace: plates, objects, a modifier, plate settings, undo, and the project file', async ({
	page
}) => {
	const shaderErrors: string[] = [];
	page.on('console', (message) => {
		if (message.type() === 'error' && /shader|WebGLProgram/i.test(message.text()))
			shaderErrors.push(message.text());
	});
	await page.goto('/');
	await ready(page);
	const imported = await page.request.post(
		'/api/slicer-projects/import?projectId=idea-03&name=synth-bambu-features.3mf&format=3mf',
		{
			data: fs.readFileSync(path.join(FIXTURES, 'synth-bambu-features.3mf')),
			headers: { 'content-type': 'application/octet-stream', origin: new URL(page.url()).origin }
		}
	);
	expect(imported.ok()).toBe(true);
	const id = (await imported.json()).slicerProject.id as string;

	await page.goto(`/projects/idea-03/slicer/${id}`);
	await ready(page);
	await expect(page.getByRole('heading', { name: 'synth-bambu-features' })).toBeVisible();
	await expect(page.locator('.slicer-canvas')).toBeVisible();
	const plates = page.getByRole('navigation', { name: 'Plates' });
	await expect(plates.getByRole('button')).toHaveCount(3); // two plates and "+ Plate"
	const objects = page.getByRole('region', { name: 'Objects on this plate' });
	await expect(objects).toContainText('Painted cube');
	await expect(objects).toContainText('✎ supports');
	// No slicer in the test app: the workspace still edits and saves.
	await expect(page.getByRole('region', { name: 'Slice and send' })).toContainText(
		'No slicer is installed'
	);

	// A new plate, then undone.
	await plates.getByRole('button', { name: '+ Plate' }).click();
	await expect(plates.getByRole('button')).toHaveCount(4);
	await page.getByRole('button', { name: 'Undo' }).click();
	await expect(plates.getByRole('button')).toHaveCount(3);

	// Select the cube, move it by typing, and give it a box modifier.
	await plates.getByRole('button', { name: /^Main/ }).click(); // plate 1 is called Main in the file
	await objects.getByRole('option', { name: /Painted cube/ }).click();
	const panel = page.getByRole('region', { name: 'Object' });
	await expect(panel.getByLabel('Name', { exact: true })).toHaveValue('Painted cube');
	await panel.getByLabel('Position Z').fill('5');
	await panel.getByLabel('Position Z').press('Enter');
	await panel.getByRole('button', { name: 'Drop to bed' }).click();
	await expect(panel.getByLabel('Position Z')).not.toHaveValue('5');
	await panel.getByText('Parts and modifiers').click();
	await panel.getByRole('button', { name: '+ Box modifier' }).click();
	await expect(objects).toContainText('Box');
	await expect(
		page.getByRole('region', { name: 'Part' }).getByLabel('Name', { exact: true })
	).toHaveValue('Box');

	// Plate settings.
	await page.getByRole('region', { name: 'Plate 1' }).getByLabel('Bed').selectOption('Cool Plate');

	// Variable layer height: adaptive layers for the cube, kept in the project file.
	await objects.getByRole('option', { name: /Painted cube/ }).click();
	// The file's cube has layer heights already: the section is open. Reset, then Adaptive.
	await expect(panel.getByText('Variable layer height (set)')).toBeVisible();
	await panel.getByRole('button', { name: 'Reset', exact: true }).click();
	await expect(panel.getByText('Variable layer height (set)')).toHaveCount(0);
	await panel.getByRole('button', { name: 'Adaptive', exact: true }).click();
	await expect(panel.getByText('Variable layer height (set)')).toBeVisible();

	// The 3D colour overlay actually renders and returns to the material colours when disabled.
	const canvas = page.locator('.slicer-canvas');
	const beforeColours = await canvas.screenshot();
	await panel.getByRole('checkbox', { name: 'Show layer colours' }).check();
	await expect(panel.getByRole('img', { name: /Layer height colours:/ })).toBeVisible();
	await expect.poll(async () => (await canvas.screenshot()).equals(beforeColours)).toBe(false);
	await panel.getByRole('checkbox', { name: 'Show layer colours' }).uncheck();
	await expect(panel.getByRole('img', { name: /Layer height colours:/ })).toHaveCount(0);
	await expect.poll(async () => (await canvas.screenshot()).equals(beforeColours)).toBe(true);
	expect(shaderErrors).toEqual([]);

	// The project file holds it all (read back by the server's 3MF reader) once it has saved.
	const saved = async () =>
		(await (await page.request.get(`/api/slicer-projects/${id}`)).json()).project;
	await expect
		.poll(async () => (await saved()).plates[0].bedType, { timeout: 10_000 })
		.toBe('Cool Plate');
	await expect
		.poll(
			async () =>
				(await saved()).objects.find((o: { name: string }) => o.name === 'Painted cube')
					.layerHeightProfile?.length ?? 0,
			{ timeout: 10_000 }
		)
		.toBeGreaterThanOrEqual(4);
	const cube = (await saved()).objects.find((o: { name: string }) => o.name === 'Painted cube');
	expect(cube.parts.map((p: { type: string }) => p.type)).toContain('modifier');

	const downloading = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Open in Bambu Studio' }).click();
	expect((await downloading).suggestedFilename()).toBe('synth-bambu-features.3mf');
});

test('a model opens in the slicer from its menu', async ({ page }) => {
	const stl = fs.readFileSync(path.join(FIXTURES, 'bambu-test-buchse.3mf'));
	const upload = await page.request.post(
		'/api/models/upload?projectId=idea-05&name=Stand%20base&format=3mf',
		{ data: stl, headers: { 'content-type': 'application/octet-stream' } }
	);
	expect(upload.ok()).toBe(true);
	await page.goto('/projects/idea-05');
	await ready(page);
	await page
		.locator('[data-model]', { hasText: 'Stand base' })
		.first()
		.dispatchEvent('contextmenu');
	await page.getByRole('menuitem', { name: 'Open in the slicer' }).click();
	await expect(page).toHaveURL(/\/projects\/idea-05\/slicer\/[\w-]+$/);
	await expect(page.getByRole('region', { name: 'Objects on this plate' })).toContainText(
		'Stand base'
	);
});
