import { expect, test, type Page } from '@playwright/test';

// Waits until the app has hydrated, so handlers are live.
const ready = (page: Page) => page.locator('html[data-ready]').waitFor({ state: 'attached' });

test.beforeEach(async ({ context }) => {
	await context.addInitScript(() => sessionStorage.setItem('print-lab-profile', 'all'));
});

test('a sliced plate’s toolpaths: layers, moves, colours and legend, on the job and before sending', async ({
	page
}) => {
	await page.goto('/jobs');
	await ready(page);
	const created = await page.request.post('/api/jobs', {
		headers: { origin: new URL(page.url()).origin },
		data: { projectId: 'idea-02', revision: 'Toolpath cube' }
	});
	expect(created.ok()).toBeTruthy();
	const job = (await created.json()).workspace.jobs.find(
		(j: { revision: string }) => j.revision === 'Toolpath cube'
	);
	const card = page.locator(`.job-card[data-job="${job.id}"]`);
	await card
		.locator('input[type=file]')
		.setInputFiles('src/lib/server/gcode/__fixtures__/a1-mini-cube.gcode.3mf');
	await expect(card.locator('.job-sliced')).toBeVisible();

	// On the job card.
	await card.getByRole('button', { name: '◫ Toolpaths' }).click();
	const dialog = page.getByRole('dialog', { name: 'Toolpaths' });
	await expect(dialog).toContainText('Layer 50 of 50', { timeout: 20_000 });
	await expect(dialog.locator('canvas')).toBeVisible();
	await expect(dialog).toContainText('Total 13 min 12 s');
	await expect(dialog).toContainText('Time per layer');
	const outer = dialog.getByRole('button', { name: 'Outer wall' });
	await expect(outer).toHaveAttribute('aria-pressed', 'true');
	await expect(dialog.getByRole('button', { name: 'Floating vertical shell' })).toBeVisible();
	await expect(dialog.getByRole('button', { name: 'Travel moves' })).toHaveAttribute(
		'aria-pressed',
		'false'
	);
	await outer.click();
	await expect(outer).toHaveAttribute('aria-pressed', 'false');

	// Down to layer 10, then through its moves.
	await dialog.getByLabel('Top layer shown').fill('9');
	await expect(dialog).toContainText('Layer 10 of 50 · 2 mm');
	await expect(dialog).toContainText('Moves in layer 10: 76 of 76');
	await dialog.getByLabel('Moves shown in the top layer').fill('20');
	await expect(dialog).toContainText('Moves in layer 10: 20 of 76');

	await dialog.getByRole('button', { name: 'Filament' }).click();
	await expect(dialog).toContainText('Filament 1 · PLA');
	await dialog.getByRole('button', { name: 'Speed' }).click();
	await expect(dialog).toContainText('mm/s');
	await dialog.getByRole('button', { name: 'Close' }).click();
	await expect(dialog).toBeHidden();

	// The preview is cached next to the sliced file and served with a long cache for its address.
	const file = (await (await page.request.get('/api/workspace')).json()).jobs.find(
		(j: { id: string }) => j.id === job.id
	).sliced.file;
	const res = await page.request.get(`/api/jobs/${job.id}/sliced/preview?plate=1&f=${file}`);
	expect(res.status()).toBe(200);
	expect(res.headers()['cache-control']).toContain('immutable');
	expect((await res.body()).subarray(0, 4).toString()).toBe('PLPV');

	// Before sending, for the chosen plate.
	await card.getByRole('button', { name: '▣ Send to printer' }).click();
	const send = page.getByRole('dialog', { name: /^Print / });
	await send.getByRole('button', { name: '◫ Show toolpaths' }).click();
	await expect(send).toContainText('Layer 50 of 50', { timeout: 20_000 });
	await send.getByRole('button', { name: '◫ Hide toolpaths' }).click();
	await expect(send).not.toContainText('Layer 50 of 50');
});
