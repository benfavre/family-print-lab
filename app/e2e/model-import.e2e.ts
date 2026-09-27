import { expect, test, type Page } from '@playwright/test';

// Model import: dropping a model file anywhere adds it to a project; the link window explains what it
// accepts; the Thingiverse token is saved without ever coming back. Nothing here reaches the internet
// (link previews from saved site answers are covered by the unit tests).
const ready = (page: Page) => page.locator('html[data-ready]').waitFor({ state: 'attached' });
const workspace = (page: Page) => page.request.get('/api/workspace').then((r) => r.json());
const STL =
	'solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid t\n';

test.describe.configure({ mode: 'serial' });
test.beforeEach(async ({ context }) => {
	await context.addInitScript(() => sessionStorage.setItem('print-lab-profile', 'all'));
});

/** Drops a file on the page body, the way a file dragged from the desktop arrives. */
async function dropFile(page: Page, name: string, text: string) {
	const dt = await page.evaluateHandle(
		([n, t]) => {
			const d = new DataTransfer();
			d.items.add(new File([t], n, { type: 'application/octet-stream' }));
			return d;
		},
		[name, text]
	);
	await page.locator('body').dispatchEvent('dragover', { dataTransfer: dt });
	await expect(page.locator('.drop-frame')).toBeVisible();
	await page.locator('body').dispatchEvent('drop', { dataTransfer: dt });
}

test('a dropped STL lands in a new project, or in the project chosen', async ({ page }) => {
	await page.goto('/');
	await ready(page);
	await dropFile(page, 'Rocket fin.stl', STL);
	const dialog = page.getByRole('dialog', { name: 'Add “Rocket fin.stl” to…' });
	await expect(dialog.getByLabel('Name')).toHaveValue('Rocket fin');
	await dialog.getByRole('button', { name: 'Add' }).click();
	await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
	await expect(page.getByRole('heading', { level: 1, name: 'Rocket fin' })).toBeVisible({
		timeout: 15_000
	});
	const id = page.url().split('/').pop()!;
	const ws = await workspace(page);
	expect(ws.models.filter((m: { projectId: string }) => m.projectId === id)).toHaveLength(1);

	// On a project page, that project is chosen by default.
	await dropFile(page, 'nose-cone.stl', STL);
	await page
		.getByRole('dialog', { name: 'Add “nose-cone.stl” to…' })
		.getByRole('button', { name: 'Add' })
		.click();
	await expect
		.poll(
			async () =>
				(await workspace(page)).models.filter((m: { projectId: string }) => m.projectId === id)
					.length
		)
		.toBe(2);

	// Other files are refused with a word.
	await dropFile(page, 'notes.pdf', '%PDF');
	await expect(page.locator('.toast').last()).toContainText('Drop STL, 3MF or OBJ files');
});

test('the link window explains which links it takes, and the server refuses local addresses', async ({
	page
}) => {
	await page.goto('/');
	await ready(page);
	await page.getByRole('button', { name: 'Import a model from a link' }).click();
	const dialog = page.getByRole('dialog', { name: 'Import from a link' });
	await dialog.getByLabel('Model page link').fill('https://example.com/model/1');
	await dialog.getByRole('button', { name: 'Look up' }).click();
	await expect(dialog.getByRole('alert')).toContainText(
		'Paste a model page link from Printables, Thingiverse or MakerWorld.'
	);
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog).toHaveCount(0);

	// A model link pasted anywhere opens the window with it filled in, and asks nothing until Look up.
	const lookups: string[] = [];
	page.on('request', (r) => r.url().includes('/api/imports/url') && lookups.push(r.url()));
	await page.evaluate(() => {
		const data = new DataTransfer();
		data.setData('text/plain', 'https://www.printables.com/model/3161-3d-benchy');
		document.body.dispatchEvent(
			new ClipboardEvent('paste', { clipboardData: data, bubbles: true })
		);
	});
	await expect(dialog.getByLabel('Model page link')).toHaveValue(
		'https://www.printables.com/model/3161-3d-benchy'
	);
	await expect(dialog.getByRole('button', { name: 'Look up' })).toBeFocused();
	expect(lookups).toEqual([]);
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog).toHaveCount(0);
	// The server refuses other sites too, before any request leaves the machine.
	const res = await page.request.post('/api/imports/url', {
		data: { url: 'https://192.168.1.1/model/1' }
	});
	expect(res.status()).toBe(400);
	const image = await page.request.get(
		`/api/imports/image?url=${encodeURIComponent('https://127.0.0.1/x.png')}`
	);
	expect(image.status()).toBe(400);
});

test('Integrations → Model links saves the Thingiverse token without showing it again', async ({
	page
}) => {
	await page.goto('/integrations');
	await ready(page);
	const section = page.locator('#model-links');
	await section.getByLabel('Thingiverse app token').fill('abc123def');
	await section.getByRole('button', { name: 'Save token' }).click();
	await expect(section.getByRole('button', { name: 'Remove token' })).toBeVisible();
	const settings = await (await page.request.get('/api/imports/settings')).json();
	expect(settings).toEqual({ hasThingiverseToken: true });
	await section.getByRole('button', { name: 'Remove token' }).click();
	await expect(section.getByRole('button', { name: 'Remove token' })).toHaveCount(0);
});
