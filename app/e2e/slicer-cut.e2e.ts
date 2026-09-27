import { expect, test } from '@playwright/test';
import { binaryStl, primitiveSoup } from '../src/lib/client/slicer/primitives';
import type { Project } from '../src/lib/shared/slicer/project';

test('cuts a painted object into independent halves, saves them and undoes the whole edit', async ({
	page,
	context
}) => {
	await context.addInitScript(() => sessionStorage.setItem('print-lab-profile', 'all'));
	const imported = await page.request.post(
		'/api/slicer-projects/import?projectId=idea-03&name=Cut%20cube.stl&format=stl',
		{
			data: Buffer.from(binaryStl(primitiveSoup('box', [20, 20, 20]))),
			headers: { 'content-type': 'application/octet-stream' }
		}
	);
	expect(imported.ok()).toBe(true);
	const id = (await imported.json()).slicerProject.id;
	const detail = await (await page.request.get(`/api/slicer-projects/${id}`)).json();
	const original: Project = detail.project;
	original.objects[0].parts[0].paint = { supports: { 0: '4' } };
	original.objects[0].heightRanges = [{ minZ: 0, maxZ: 5, config: { layer_height: '0.12' } }];
	const painted = await page.request.put(`/api/slicer-projects/${id}`, {
		data: original,
		headers: { 'if-match': String(detail.revision) }
	});
	expect(painted.ok()).toBe(true);
	await page.goto(`/projects/idea-03/slicer/${id}`);
	await page.locator('html[data-ready]').waitFor({ state: 'attached' });
	const objects = page.getByRole('region', { name: 'Objects on this plate' });
	await objects.getByRole('option', { name: /Cut cube/ }).click();
	const panel = page.getByRole('region', { name: 'Object', exact: true });
	await panel.getByText('Cut', { exact: true }).click();
	await expect(panel.getByRole('button', { name: 'Cut object', exact: true })).toBeDisabled();
	await panel.getByLabel('Cut position (mm)').fill('7');
	await panel.getByLabel('Clear geometry details for this cut').check();
	await panel.getByRole('button', { name: 'Cut object', exact: true }).click();
	await expect(objects.getByRole('option', { name: /Cut cube \(below\)/ })).toBeVisible();
	await expect(objects.getByRole('option', { name: /Cut cube \(above\)/ })).toBeVisible();
	const saved = async (): Promise<Project> =>
		(await (await page.request.get(`/api/slicer-projects/${id}`)).json()).project;
	await expect.poll(async () => (await saved()).objects.length).toBe(2);
	const after = await saved();
	for (const object of after.objects) {
		expect(object.parts[0].transform).toEqual(original.objects[0].parts[0].transform);
		expect(object.instances[0].transform).toEqual(original.objects[0].instances[0].transform);
		expect(object.parts[0].paint).toBeUndefined();
		expect(object.heightRanges).toEqual([]);
	}
	expect(after.plates[0].instances).toHaveLength(2);
	expect(new Set(after.objects.map((o) => o.parts[0].mesh)).size).toBe(2);
	await page.getByRole('button', { name: 'Undo', exact: true }).click();
	await expect(objects.getByRole('option', { name: /Cut cube \(above\)/ })).toHaveCount(0);
	await expect.poll(async () => (await saved()).objects.length).toBe(1);
	expect((await saved()).objects[0].parts[0].paint).toEqual(original.objects[0].parts[0].paint);
	await page.getByRole('button', { name: 'Redo', exact: true }).click();
	await expect(objects.getByRole('option', { name: /Cut cube \(above\)/ })).toBeVisible();
});

test('leaving the workspace cancels a late cut without starting another save', async ({
	page,
	context
}) => {
	await context.addInitScript(() => sessionStorage.setItem('print-lab-profile', 'all'));
	const imported = await page.request.post(
		'/api/slicer-projects/import?projectId=idea-03&name=Late%20cut.stl&format=stl',
		{
			data: Buffer.from(binaryStl(primitiveSoup('box', [20, 20, 20]))),
			headers: { 'content-type': 'application/octet-stream' }
		}
	);
	const id = (await imported.json()).slicerProject.id;
	const before = await (await page.request.get(`/api/slicer-projects/${id}`)).json();
	await page.goto(`/projects/idea-03/slicer/${id}`);
	await page.locator('html[data-ready]').waitFor({ state: 'attached' });
	await page.getByRole('option', { name: /Late cut/ }).click();
	const panel = page.getByRole('region', { name: 'Object', exact: true });
	await panel.getByText('Cut', { exact: true }).click();
	let release!: () => void, started!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const pending = new Promise<void>((resolve) => {
		started = resolve;
	});
	await page.route('**/api/slicer-ui/meshes/cut', async (route) => {
		const response = await route.fetch();
		started();
		await held;
		await route.fulfill({ response }).catch(() => {}); // A cancelled request may already be closed.
	});
	await panel.getByRole('button', { name: 'Cut object', exact: true }).click();
	await pending;
	await page.locator('.sw-top .crumbs a').click(); // Svelte navigation disposes the workspace.
	await expect(page).toHaveURL('/projects/idea-03');
	release();
	// A stale callback used to restart the 1200 ms autosave after the workspace was disposed.
	await page.waitForTimeout(1600);
	expect(await (await page.request.get(`/api/slicer-projects/${id}`)).json()).toEqual(before);
});
