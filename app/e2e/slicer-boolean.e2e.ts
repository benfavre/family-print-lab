import { expect, test } from '@playwright/test';
import { binaryStl, primitiveSoup } from '../src/lib/client/slicer/primitives';
import type { Project } from '../src/lib/shared/slicer/project';

test('subtracts the second selected object in place, saves and restores both with undo', async ({
	page,
	context
}) => {
	await context.addInitScript(() => sessionStorage.setItem('print-lab-profile', 'all'));
	const imported = await page.request.post(
		'/api/slicer-projects/import?projectId=idea-03&name=Target.stl&format=stl',
		{
			data: Buffer.from(binaryStl(primitiveSoup('box', [20, 20, 20]))),
			headers: { 'content-type': 'application/octet-stream' }
		}
	);
	expect(imported.ok()).toBe(true);
	const id = (await imported.json()).slicerProject.id;
	const detail = await (await page.request.get(`/api/slicer-projects/${id}`)).json();
	const original: Project = detail.project;
	const first = original.objects[0];
	first.parts[0].paint = { color: { 0: '4' } };
	first.config.wall_loops = '4';
	const second = structuredClone(first);
	second.id = 'second';
	second.name = 'Cutter';
	delete second.sourceId;
	second.parts[0].id = 'second-p1';
	delete second.parts[0].sourceId;
	second.instances[0].id = 'second-i1';
	second.instances[0].transform[9] += 10;
	original.objects.push(second);
	original.plates[0].instances.push({ objectId: second.id, instanceId: second.instances[0].id });
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
	const objects = page.getByRole('region', { name: 'Objects on this plate' });
	await objects.getByRole('option', { name: /Target/ }).click();
	await objects.getByRole('option', { name: /Cutter/ }).click({ modifiers: ['Control'] });
	const selection = page.getByRole('region', { name: 'Selection' });
	await selection.getByText('Combine', { exact: true }).click();
	await selection.getByLabel('Operation').selectOption('subtract');
	await expect(selection.getByRole('button', { name: 'Combine objects' })).toBeDisabled();
	await selection.getByLabel('Clear geometry details for this combination').check();
	await selection.getByRole('button', { name: 'Combine objects' }).click();
	await expect(objects.getByRole('option', { name: /Cutter/ })).toHaveCount(0);
	const saved = async (): Promise<Project> =>
		(await (await page.request.get(`/api/slicer-projects/${id}`)).json()).project;
	await expect.poll(async () => (await saved()).objects.length).toBe(1);
	const after = await saved(),
		result = after.objects[0];
	expect(result.instances[0].transform).toEqual(first.instances[0].transform);
	expect(result.parts[0].transform).toEqual(first.parts[0].transform);
	expect(result.config.wall_loops).toBe('4');
	expect(result.parts[0].paint).toBeUndefined();
	const box = after.meshes[result.parts[0].mesh].bbox;
	expect(box[3] - box[0]).toBeCloseTo(10);
	expect(after.plates[0].instances).toHaveLength(1);
	await page.getByRole('button', { name: 'Undo', exact: true }).click();
	await expect(objects.getByRole('option', { name: /Cutter/ })).toBeVisible();
	await expect.poll(async () => (await saved()).objects.length).toBe(2);
	expect((await saved()).objects[0].parts[0].paint).toEqual(first.parts[0].paint);
});

test('changing selection cancels a late combination', async ({ page, context }) => {
	await context.addInitScript(() => sessionStorage.setItem('print-lab-profile', 'all'));
	const imported = await page.request.post(
		'/api/slicer-projects/import?projectId=idea-03&name=Late%20target.stl&format=stl',
		{
			data: Buffer.from(binaryStl(primitiveSoup('box', [20, 20, 20]))),
			headers: { 'content-type': 'application/octet-stream' }
		}
	);
	const id = (await imported.json()).slicerProject.id;
	const detail = await (await page.request.get(`/api/slicer-projects/${id}`)).json();
	const project: Project = detail.project;
	const second = structuredClone(project.objects[0]);
	second.id = 'second';
	second.name = 'Late cutter';
	delete second.sourceId;
	second.parts[0].id = 'second-p1';
	delete second.parts[0].sourceId;
	second.instances[0].id = 'second-i1';
	second.instances[0].transform[9] += 10;
	project.objects.push(second);
	project.plates[0].instances.push({ objectId: second.id, instanceId: second.instances[0].id });
	await page.request.put(`/api/slicer-projects/${id}`, {
		data: project,
		headers: { 'if-match': String(detail.revision) }
	});
	const before = await (await page.request.get(`/api/slicer-projects/${id}`)).json();
	await page.goto(`/projects/idea-03/slicer/${id}`);
	await page.locator('html[data-ready]').waitFor({ state: 'attached' });
	const objects = page.getByRole('region', { name: 'Objects on this plate' });
	await objects.getByRole('option', { name: /Late target/ }).click();
	await objects.getByRole('option', { name: /Late cutter/ }).click({ modifiers: ['Control'] });
	const selection = page.getByRole('region', { name: 'Selection' });
	await selection.getByText('Combine', { exact: true }).click();
	let release!: () => void, started!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const pending = new Promise<void>((resolve) => {
		started = resolve;
	});
	await page.route('**/api/slicer-ui/meshes/boolean', async (route) => {
		const response = await route.fetch();
		started();
		await held;
		await route.fulfill({ response }).catch(() => {});
	});
	await selection.getByRole('button', { name: 'Combine objects', exact: true }).click();
	await pending;
	await objects.getByRole('option', { name: /Late target/ }).click();
	await expect(selection).toHaveCount(0);
	release();
	await page.waitForTimeout(1600); // A stale result must not start the 1200 ms autosave.
	await expect(objects.getByRole('option', { name: /Late cutter/ })).toBeVisible();
	expect(await (await page.request.get(`/api/slicer-projects/${id}`)).json()).toEqual(before);
});
