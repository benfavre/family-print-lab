import { expect, test } from '@playwright/test';
import type { Project } from '../src/lib/shared/slicer/project';

// Two large facets distinguish a small brush's saved subdivision from whole-face painting.
const square = `solid brush
facet normal 0 0 1
outer loop
vertex -50 -50 0
vertex 50 -50 0
vertex 50 50 0
endloop
endfacet
facet normal 0 0 1
outer loop
vertex -50 -50 0
vertex 50 50 0
vertex -50 50 0
endloop
endfacet
endsolid brush`;

test('a small brush saves native subdivisions and can erase them after reopening', async ({
	page
}) => {
	await page.addInitScript(() => sessionStorage.setItem('print-lab-profile', 'all'));
	const imported = await page.request.post(
		'/api/slicer-projects/import?projectId=idea-03&name=Brush%20square.stl&format=stl',
		{ data: square, headers: { 'content-type': 'application/octet-stream' } }
	);
	expect(imported.ok()).toBe(true);
	const id = (await imported.json()).slicerProject.id as string;
	const saved = async (): Promise<Project> =>
		(await (await page.request.get(`/api/slicer-projects/${id}`)).json()).project;
	await page.goto(`/projects/idea-03/slicer/${id}`);
	await page.locator('html[data-ready]').waitFor({ state: 'attached' });
	await page.getByRole('option', { name: /Brush square/ }).click();
	const object = page.getByRole('region', { name: 'Object', exact: true });
	for (const axis of ['X', 'Y']) {
		await object.getByLabel(`Position ${axis}`).fill('128');
		await object.getByLabel(`Position ${axis}`).press('Enter');
	}
	await object.getByText('Painting', { exact: true }).click();
	await object.getByRole('button', { name: /^Supports/ }).click();
	const painting = page.getByRole('region', { name: 'Painting', exact: true });
	await painting.getByRole('slider', { name: /Brush/ }).fill('1');
	const originalMeshes = (await saved()).meshes;
	const canvas = page.locator('.slicer-canvas');
	await canvas.click();
	await expect
		.poll(async () =>
			Object.values((await saved()).objects[0].parts[0].paint?.supports ?? {}).some(
				(s) => s.length > 1
			)
		)
		.toBe(true);
	const painted = (await saved()).objects[0].parts[0].paint;
	expect((await saved()).meshes).toEqual(originalMeshes);

	// Reopening draws native leaves; the next pick must still name the original source facet,
	// rather than the drawing mesh's subdivided face index.
	await page.reload();
	await page.locator('html[data-ready]').waitFor({ state: 'attached' });
	await page.getByRole('option', { name: /Brush square/ }).click();
	await object.getByText('Painting', { exact: true }).click();
	await object.getByRole('button', { name: /^Supports/ }).click();
	expect((await saved()).objects[0].parts[0].paint).toEqual(painted);
	await painting.getByRole('radio', { name: 'Erase', exact: true }).click();
	await painting.getByRole('slider', { name: /Brush/ }).fill('2');
	await canvas.click();
	await expect
		.poll(async () => (await saved()).objects[0].parts[0].paint?.supports)
		.toBeUndefined();
	expect((await saved()).meshes).toEqual(originalMeshes);
});
