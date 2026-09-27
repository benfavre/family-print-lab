import { expect, test, type Page } from '@playwright/test';

// Printer errors in plain words: a simulated AMS runout shows its text, severity, wiki link and
// Bambu's button; pressing it resumes the print, and the Alerts page keeps both alerts with their times.
const SIM = 'http://127.0.0.1:18661';
const ready = (page: Page) => page.locator('html[data-ready]').waitFor({ state: 'attached' });
const simState = (page: Page) =>
	page.request.get(`${SIM}/api/state`).then(async (r) => (await r.json()).printers[0].state);

test.beforeEach(async ({ context }) => {
	await context.addInitScript(() => sessionStorage.setItem('print-lab-profile', 'all'));
});

test('an AMS runout in plain words, resolved with Bambu’s button, kept in the history', async ({
	page
}) => {
	const printers: { id: string; model: string }[] = await (
		await page.request.get('/api/printers')
	).json();
	const x2d = printers.find((p) => p.model === 'N6')!;
	expect(x2d).toBeTruthy();
	await page.request.post(`${SIM}/api/start`, { data: { name: 'hms_check', minutes: 180 } });
	await expect
		.poll(async () => (await simState(page)).gcode_state, { timeout: 30_000 })
		.toBe('RUNNING');

	try {
		const raised = await page.request.post(`${SIM}/api/feature`, {
			data: { feature: 'hms', control: 'ams-runout' }
		});
		expect(raised.ok()).toBe(true);

		await page.goto(`/printers/${x2d.id}`);
		await ready(page);
		const panel = page.locator('section.panel', {
			has: page.getByRole('heading', { name: 'Alerts' })
		});
		const error = panel.locator('.hms-alert', { hasText: '0700_8011' });
		await expect(error).toContainText('AMS filament ran out.', { timeout: 15_000 });
		await expect(error).toContainText('Warning');
		const alert = panel.locator('.hms-alert', { hasText: /filament has run out/ });
		await expect(alert).toContainText('Serious');
		await expect(alert.getByRole('link', { name: 'Learn more ↗' })).toHaveAttribute(
			'href',
			/^https:\/\/wiki\.bambulab\.com\/en\//
		);

		// Switching the offline message language updates an already open printer page.
		const settings = await page.context().newPage();
		try {
			await settings.goto('/integrations#settings-hms');
			await ready(settings);
			await settings.getByLabel('Message language').selectOption('fr');
			await expect(error).not.toContainText('AMS filament ran out.');
			await expect(error).toContainText('filament');
			await settings.reload();
			await expect(settings.getByLabel('Message language')).toHaveValue('fr');
			await settings.getByLabel('Message language').selectOption('en');
			await expect(error).toContainText('AMS filament ran out.');
		} finally {
			await settings.close();
		}

		await error.getByRole('button', { name: 'Resume (problem solved)' }).click();
		await expect(panel).toContainText('No errors reported.', { timeout: 15_000 });
		await expect.poll(async () => (await simState(page)).gcode_state).toBe('RUNNING');

		await page
			.getByRole('navigation', { name: /pages/ })
			.getByRole('link', { name: 'Alerts' })
			.click();
		await expect(page).toHaveURL(new RegExp(`/printers/${x2d.id}/alerts$`));
		const history = page.locator('.history li');
		await expect(history).toHaveCount(2);
		await expect(history.first()).not.toContainText('still active');
		await page.getByRole('button', { name: 'Warnings' }).click();
		await expect(history).toHaveCount(1);
		await expect(history.first()).toContainText('0700_8011');

		await page.getByLabel('Error code').fill('0300-400c');
		await page.getByRole('button', { name: 'Look up' }).click();
		await expect(page.locator('.lookup ~ .hms-alert')).toContainText('The task was canceled.');
	} finally {
		await page.request.put('/api/hms/settings', { data: { language: 'en' } });
		await page.request.post(`${SIM}/api/stop`);
	}
});
