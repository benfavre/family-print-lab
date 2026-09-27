import { expect, test, type Page } from '@playwright/test';

// Waits until the app has hydrated, so handlers are live.
const ready = (page: Page) => page.locator('html[data-ready]').waitFor({ state: 'attached' });
const workspace = (page: Page) => page.request.get('/api/workspace').then((r) => r.json());
// API calls from inside the page, with its cookies (kid mode lives in a browser cookie).
const call = (page: Page, method: string, url: string, body?: unknown) =>
	page.evaluate(
		async ([method, url, body]) => {
			const r = await fetch(url as string, {
				method: method as string,
				headers: body ? { 'content-type': 'application/json' } : undefined,
				body: body ? JSON.stringify(body) : undefined
			});
			return { status: r.status, body: await r.json().catch(() => null) };
		},
		[method, url, body]
	);
// A 1×1 PNG: the browser shrinks and re-encodes it before upload.
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64'
);

test.beforeEach(async ({ context }) => {
	await context.addInitScript(() => sessionStorage.setItem('print-lab-profile', 'all'));
});

test('a child over the daily limit hears “not today”; a finished print earns a badge, a photo and a certificate', async ({
	page
}) => {
	// A grown-up (the PIN may already be set by the kid mode test) adds a child in kid mode.
	await page.request.post('/api/parent/pin', { data: { pin: '2468' } });
	const created = await page.request.post('/api/profiles', {
		data: { name: 'Robin', color: 'green', age: 9, kid: 'junior' }
	});
	expect(created.ok()).toBe(true);
	const robin = (await created.json()).id as string;

	// One print a day, set on the Family page.
	await page.goto('/family');
	await ready(page);
	const panel = page.locator('.kids-panel');
	const card = panel.locator('.kid', { hasText: 'Robin' });
	await card.getByRole('button', { name: 'Limits' }).click();
	await card.getByLabel('Prints a day').fill('1');
	await card.getByRole('button', { name: 'Save limits' }).click();
	await expect(page.getByText('Limits for Robin saved.')).toBeVisible();
	await expect(card).toContainText('Today 0 / 1 prints');

	// Robin makes two things in kid mode and asks for the first.
	expect((await call(page, 'POST', '/api/kid/enter', { profileId: robin })).status).toBe(200);
	const make = async (template: string) => {
		const res = await call(page, 'POST', '/api/kid/things', { template, params: {} });
		expect(res.status).toBe(200);
		return res.body.projectId as string;
	};
	const first = await make('stencil');
	const second = await make('treasure-dish');
	await page.goto(`/kid/things/${first}`);
	await ready(page);
	await page.getByRole('button', { name: '🙋 Ask a grown-up to print it' }).click();
	await expect(page.getByText('Waiting for a grown-up')).toBeVisible();

	// The second one has to wait until tomorrow.
	await page.goto(`/kid/things/${second}`);
	await ready(page);
	await expect(
		page.getByText('That’s all the printing for today. Ask again tomorrow!')
	).toBeVisible();
	await expect(page.getByRole('button', { name: '🙋 Ask a grown-up to print it' })).toBeDisabled();
	expect((await call(page, 'POST', `/api/kid/things/${second}/ask`, {})).status).toBe(409);
	expect((await call(page, 'POST', '/api/kid/exit', { pin: '2468' })).status).toBe(200);

	// The grown-up says yes, and the print is made.
	const request = (await workspace(page)).printRequests.find(
		(r: { profileId: string }) => r.profileId === robin
	);
	const decided = await page.request.post(`/api/requests/${request.id}`, {
		data: { decision: 'approve', version: request.version }
	});
	const jobId = (await decided.json()).jobId as string;
	await page.request.post(`/api/jobs/${jobId}/transition`, { data: { to: 'Printing' } });
	await page.request.post(`/api/jobs/${jobId}/transition`, { data: { to: 'Succeeded' } });

	// The gallery invites a photo of it; the grown-up adds one.
	await page.goto('/family/gallery');
	await ready(page);
	const wanted = page.locator('.wanted li', { hasText: 'Robin' });
	await expect(wanted).toContainText('Drawing stencil');
	await wanted
		.locator('input[type=file]')
		.setInputFiles({ name: 'stencil.png', mimeType: 'image/png', buffer: PNG });
	await expect(page.getByText('Photo added to the gallery.')).toBeVisible();
	const photo = page.locator('.photo', { hasText: 'Drawing stencil' });
	await expect(photo).toContainText('Robin');
	await expect(photo.locator('img')).toHaveJSProperty('complete', true);

	// A printable certificate, with the badge the print earned.
	await photo.getByRole('link', { name: /Certificate/ }).click();
	await expect(page.getByRole('heading', { name: 'Certificate of making' })).toBeVisible();
	const certificate = page.getByRole('article', { name: 'Certificate for Robin' });
	await expect(certificate).toContainText('Drawing stencil');
	await expect(certificate).toContainText('First print');
	await expect(page.getByRole('button', { name: 'Print certificate' })).toBeVisible();

	// Back in kid mode, Robin celebrates the badge and sees the photo.
	await call(page, 'POST', '/api/kid/enter', { profileId: robin });
	await page.goto('/kid');
	await ready(page);
	await expect(page.getByText('You got a new badge!')).toBeVisible();
	await page.getByRole('button', { name: 'Yay! 🎉' }).click();
	await expect(page.getByText('You got a new badge!')).toHaveCount(0);
	await expect(page.locator('.badge.got')).toContainText('First print');
	await expect(page.locator('.photos li')).toContainText('Drawing stencil');
	await call(page, 'POST', '/api/kid/exit', { pin: '2468' });
});
