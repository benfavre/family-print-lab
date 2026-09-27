import { expect, test } from '@playwright/test';
import { binaryStl, primitiveSoup } from '../src/lib/client/slicer/primitives';
import type { Project } from '../src/lib/shared/slicer/project';

test('adds raised text and engraves it with original placement, persistence and undo', async ({
	page,
	context
}) => {
	await context.addInitScript(() => sessionStorage.setItem('print-lab-profile', 'all'));
	const imported = await page.request.post(
		'/api/slicer-projects/import?projectId=idea-03&name=Label%20block.stl&format=stl',
		{
			data: Buffer.from(binaryStl(primitiveSoup('box', [40, 40, 20]))),
			headers: { 'content-type': 'application/octet-stream' }
		}
	);
	expect(imported.ok()).toBe(true);
	const id = (await imported.json()).slicerProject.id;
	const saved = async (): Promise<Project> =>
		(await (await page.request.get(`/api/slicer-projects/${id}`)).json()).project;
	const original = await saved();
	await page.goto(`/projects/idea-03/slicer/${id}`);
	await page.locator('html[data-ready]').waitFor({ state: 'attached' });
	await page.getByRole('option', { name: /Label block/ }).click();
	const panel = page.getByRole('region', { name: 'Object', exact: true });
	await panel.getByText('Text', { exact: true }).click();
	await panel.getByLabel('Text to add').fill('Hi');
	await panel.getByRole('button', { name: 'Pick text face' }).click();
	await expect(panel.getByRole('status')).toContainText('Click a face');
	const canvas = page.locator('.slicer-canvas');
	const box = await canvas.boundingBox();
	await canvas.click({ position: { x: box!.width / 2, y: box!.height / 2 } });
	await expect(panel.getByLabel('Text position Z')).toBeVisible();
	const normal = await Promise.all(
		['X', 'Y', 'Z'].map(async (axis) =>
			Number(await panel.getByLabel(`Text direction ${axis}`).inputValue())
		)
	);
	expect(Math.hypot(...normal)).toBeCloseTo(1);
	await panel.getByRole('button', { name: 'Pick text face' }).click();
	await page.keyboard.press('Escape');
	await page.getByRole('option', { name: /Label block/ }).click();
	await panel.getByText('Text', { exact: true }).click();
	await panel.getByLabel('Text to add').fill('Hi');
	await panel.getByRole('button', { name: 'Use top centre' }).click();
	await panel.getByRole('button', { name: 'Add raised text', exact: true }).click();
	const originalMesh = original.objects[0].parts[0].mesh;
	await expect
		.poll(async () => (await saved()).objects[0].parts[0].mesh, { timeout: 30_000 })
		.not.toBe(originalMesh);
	const raised = await saved(),
		object = raised.objects[0];
	expect(object.instances).toEqual(original.objects[0].instances);
	expect(object.parts[0].transform).toEqual(original.objects[0].parts[0].transform);
	expect(raised.meshes[object.parts[0].mesh].bbox[5]).toBeGreaterThan(
		original.meshes[originalMesh].bbox[5]
	);
	await page.getByRole('button', { name: 'Undo', exact: true }).click();
	await expect.poll(async () => (await saved()).objects[0].parts[0].mesh).toBe(originalMesh);
	await panel.getByLabel('Text mode').selectOption('engrave');
	await panel.getByRole('button', { name: 'Use top centre' }).click();
	await panel.getByRole('button', { name: 'Engrave text', exact: true }).click();
	await expect
		.poll(async () => (await saved()).objects[0].parts[0].mesh, { timeout: 30_000 })
		.not.toBe(originalMesh);
	const engraved = await saved();
	expect(engraved.objects[0].instances).toEqual(original.objects[0].instances);
	expect(engraved.meshes[engraved.objects[0].parts[0].mesh].bbox).toEqual(
		original.meshes[originalMesh].bbox
	);
	expect(engraved.objects[0].parts[0].mesh).not.toBe(object.parts[0].mesh);
});
