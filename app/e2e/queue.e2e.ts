import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// Waits until the app has hydrated, so handlers are live.
const ready = (page: Page) => page.locator('html[data-ready]').waitFor({ state: 'attached' });
const workspace = (page: Page) => page.request.get('/api/workspace').then((r) => r.json());
const CLIP = fs.readFileSync('src/lib/server/__fixtures__/cable-clip.gcode.3mf');

test.beforeEach(async ({ context, request }) => {
	await context.addInitScript(() => sessionStorage.setItem('print-lab-profile', 'all'));
	// The suite's usual pace, whatever an earlier test left.
	await request.post('http://127.0.0.1:18661/api/speed', { data: { speed: 120 } });
});

/** A queued job on a sample project with the sliced cable clip attached. */
async function slicedJob(page: Page, revision: string): Promise<string> {
	const origin = new URL(page.url()).origin;
	const created = await page.request.post('/api/jobs', {
		headers: { origin },
		data: { projectId: 'idea-02', revision }
	});
	expect(created.ok()).toBeTruthy();
	const id = (await created.json()).workspace.jobs.find(
		(j: { revision: string }) => j.revision === revision
	).id;
	const attached = await page.request.post(`/api/jobs/${id}/sliced?name=clip.gcode.3mf`, {
		headers: { origin, 'content-type': 'application/octet-stream' },
		data: CLIP
	});
	expect(attached.ok()).toBeTruthy();
	return id;
}
const jobStatus = async (page: Page, id: string) =>
	(await workspace(page)).jobs.find((j: { id: string }) => j.id === id).status;

test('the queue starts two jobs one after another, the second once the plate is cleared', async ({
	page
}) => {
	// Two whole prints and their poll budgets.
	test.setTimeout(150_000);
	await page.goto('/queue');
	await ready(page);
	const origin = new URL(page.url()).origin;
	const printer = (await (await page.request.get('/api/printers')).json())[0];
	// Earlier tests printed on this printer; start from a clear plate.
	await page.request.post(`/api/queue/printers/${printer.id}`, {
		headers: { origin },
		data: { plateCleared: true }
	});
	const first = await slicedJob(page, 'Queue one');
	const second = await slicedJob(page, 'Queue two');

	const column = page.locator(`[data-column="${printer.id}"]`);
	const form = page.getByRole('form', { name: 'Add a job to the queue' });
	await expect(form).toBeVisible();

	// Paused while we line them up: two, then one.
	await column.getByRole('button', { name: 'Pause' }).click();
	await expect(column).toContainText('The queue is paused for this printer.');
	for (const id of [second, first]) {
		await form.getByLabel('Job').selectOption(id);
		await form.getByLabel('Printer').selectOption(printer.id);
		await form.getByRole('button', { name: 'Add to queue' }).click();
		await expect(
			column.locator('li', { hasText: id === first ? 'Queue one' : 'Queue two' })
		).toBeVisible();
	}
	// One moves to the top with the keyboard.
	const items = column.locator('li[data-item]');
	await expect(items).toHaveText([/Queue two/, /Queue one/]);
	await items.nth(1).locator('.handle').focus();
	await page.keyboard.press('Alt+ArrowUp');
	await expect(items).toHaveText([/Queue one/, /Queue two/]);
	const two = column.locator('li', { hasText: 'Queue two' });
	await two.getByRole('button', { name: 'Hold' }).click();
	await expect(two).toContainText('On hold');

	// Resumed: the first starts by itself; the timeline shows the plan.
	await column.getByRole('button', { name: 'Resume' }).click();
	await expect.poll(() => jobStatus(page, first), { timeout: 20_000 }).toBe('Printing');
	await page.getByRole('tab', { name: 'Timeline' }).click();
	await expect(page.getByRole('img', { name: 'Queue timeline' })).toBeVisible();
	await page.getByRole('tab', { name: 'Columns' }).click();

	// Released, the second waits for the print to end and the plate to be cleared.
	await two.getByRole('button', { name: 'Release' }).click();
	await expect.poll(() => jobStatus(page, first), { timeout: 40_000 }).toBe('Succeeded');
	await expect(column).toContainText('Waiting for someone to clear the plate.', {
		timeout: 10_000
	});
	expect(await jobStatus(page, second)).toBe('Queued');

	// The printer page offers the same button under "Up next".
	await page.goto(`/printers/${printer.id}`);
	await ready(page);
	const upNext = page.getByRole('region', { name: 'Up next' });
	await expect(upNext).toContainText('Queue two');
	await upNext.getByRole('button', { name: 'Plate is clear' }).click();
	await expect.poll(() => jobStatus(page, second), { timeout: 20_000 }).toBe('Printing');
	await expect.poll(() => jobStatus(page, second), { timeout: 40_000 }).toBe('Succeeded');
});
