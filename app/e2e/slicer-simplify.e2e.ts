import { expect, test, type Page } from '@playwright/test';
import { binaryStl, primitiveSoup } from '../src/lib/client/slicer/primitives';
import type { Project } from '../src/lib/shared/slicer/project';

async function sphere(page: Page) {
	await page.addInitScript(() => sessionStorage.setItem('print-lab-profile', 'all'));
	const imported = await page.request.post(
		'/api/slicer-projects/import?projectId=idea-03&name=Detailed%20sphere.stl&format=stl',
		{
			data: Buffer.from(binaryStl(primitiveSoup('sphere', [20, 20, 20], 48))),
			headers: { 'content-type': 'application/octet-stream' }
		}
	);
	expect(imported.ok()).toBe(true);
	const id = (await imported.json()).slicerProject.id as string;
	const detail = await (await page.request.get(`/api/slicer-projects/${id}`)).json();
	const original: Project = detail.project;
	original.objects[0].parts[0].transform[9] = 3;
	original.objects[0].parts[0].paint = { seam: { 0: '4' } };
	original.objects[0].layerHeightProfile = [0, 0.2, 10, 0.15, 20, 0.1];
	expect(
		(
			await page.request.put(`/api/slicer-projects/${id}`, {
				data: original,
				headers: { 'if-match': String(detail.revision) }
			})
		).ok()
	).toBe(true);
	await page.goto(`/projects/idea-03/slicer/${id}`);
	await page.locator('html[data-ready]').waitFor({ state: 'attached' });
	await page.getByRole('option', { name: /Detailed sphere/ }).click();
	const panel = page.getByRole('region', { name: 'Object', exact: true });
	await panel.getByText('Simplify', { exact: true }).click();
	const saved = async (): Promise<Project> =>
		(await (await page.request.get(`/api/slicer-projects/${id}`)).json()).project;
	return { id, original, panel, saved };
}

test('simplifies a painted solid in place, saves it and restores metadata with undo', async ({
	page
}) => {
	const { original, panel, saved } = await sphere(page);
	const simplify = panel.getByRole('button', { name: 'Simplify object', exact: true });
	await expect(simplify).toBeDisabled();
	await panel.getByLabel('Clear geometry details for this simplification').check();
	await panel.getByLabel('Maximum surface change (mm)').fill('0.1');
	await simplify.click();
	await expect(panel.getByRole('status')).toContainText('→');
	const source = original.objects[0].parts[0].mesh;
	await expect.poll(async () => (await saved()).objects[0].parts[0].mesh).not.toBe(source);
	const after = await saved();
	const object = after.objects[0];
	expect(after.meshes[object.parts[0].mesh].triangles).toBeLessThan(
		original.meshes[source].triangles
	);
	expect(object.parts[0].paint).toBeUndefined();
	expect(object.layerHeightProfile).toBeUndefined();
	expect(object.parts[0].transform).toEqual(original.objects[0].parts[0].transform);
	expect(object.instances).toEqual(original.objects[0].instances);
	await page.getByRole('button', { name: 'Undo', exact: true }).click();
	await expect.poll(async () => (await saved()).objects[0].parts[0].mesh).toBe(source);
	expect((await saved()).objects[0]).toEqual(original.objects[0]);
});

test('a late simplification never overwrites a newer project edit', async ({ page }) => {
	const { original, panel, saved } = await sphere(page);
	let finish!: () => void;
	const gate = new Promise<void>((resolve) => {
		finish = resolve;
	});
	let started!: () => void;
	const processing = new Promise<void>((resolve) => {
		started = resolve;
	});
	await page.route('**/api/slicer-ui/meshes/simplify', async (route) => {
		const response = await route.fetch();
		started();
		await gate;
		await route.fulfill({ response });
	});
	await panel.getByLabel('Clear geometry details for this simplification').check();
	await panel.getByRole('button', { name: 'Simplify object', exact: true }).click();
	await processing;
	await panel.getByLabel('Name', { exact: true }).fill('Keep this newer name');
	await panel.getByLabel('Name', { exact: true }).press('Tab');
	finish();
	await expect(panel.getByRole('alert')).toContainText('project changed while simplifying');
	await expect.poll(async () => (await saved()).objects[0].name).toBe('Keep this newer name');
	expect((await saved()).objects[0].parts[0]).toEqual(original.objects[0].parts[0]);
});
