import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';

// Integrations → Notifications with a local stand-in for an ntfy server: add a channel, test it, then
// a simulated failed print rings the bell and reaches the channel.
const ready = (page: Page) => page.locator('html[data-ready]').waitFor({ state: 'attached' });
const SIM = 'http://127.0.0.1:18661';

test.beforeEach(async ({ context }) => {
	await context.addInitScript(() => sessionStorage.setItem('print-lab-profile', 'all'));
});

test('Notifications: add an ntfy channel, test it, and hear about a failed print', async ({
	page
}) => {
	const received: { url: string; title: string; auth: string }[] = [];
	const server = http.createServer((req, res) => {
		req.resume();
		req.on('end', () => {
			received.push({
				url: req.url ?? '',
				title: String(req.headers['x-title'] ?? ''),
				auth: String(req.headers.authorization ?? '')
			});
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end('{"id":"x"}');
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const ntfy = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	try {
		await page.goto('/integrations');
		await ready(page);
		const section = page.locator('#notifications');
		await expect(section.getByRole('heading', { name: 'Notifications' })).toBeVisible();
		await section.getByRole('button', { name: '＋ Add a channel' }).click();
		await section.getByRole('menuitem', { name: 'ntfy' }).click();

		const form = page.getByRole('dialog', { name: 'Add ntfy' });
		await expect(form).toContainText('anyone who knows the topic');
		await expect(form.getByLabel('Topic')).toHaveValue(/^printlab-[a-z0-9]{10}$/);
		await form.getByLabel('Name').fill('Phone');
		await form.getByLabel('Server').fill(ntfy);
		await form.getByLabel('Topic').fill('family-lab-e2e');
		await form.getByLabel('Access token (optional)').fill('tk_e2e_secret');
		await expect(form.getByLabel('Print failed')).toBeChecked();
		await form.getByRole('button', { name: 'Send a test' }).click();
		await expect(form.locator('.result')).toContainText('Delivered.');
		expect(received.at(-1)).toMatchObject({
			url: '/family-lab-e2e',
			title: 'Test from Family Print Lab',
			auth: 'Bearer tk_e2e_secret'
		});
		await form.getByRole('button', { name: 'Add channel' }).click();
		const row = section.locator('li[data-channel]', { hasText: 'Phone' });
		await expect(row).toContainText('topic family-lab-e2e · token saved');

		// The token is write-only.
		const settings = await (await page.request.get('/api/notifications/settings')).json();
		expect(JSON.stringify(settings)).not.toContain('tk_e2e_secret');

		// A print fails on the simulated X2D.
		await page.request.post(`${SIM}/api/stop`).catch(() => {});
		await page.request.post(`${SIM}/api/start`, { data: { name: 'e2e_rocket', minutes: 30 } });
		await expect
			.poll(async () => (await (await page.request.get('/api/printers')).json())[0]?.state?.task)
			.toBe('e2e_rocket');
		await page.request.post(`${SIM}/api/fail`);

		const bell = page.getByRole('button', { name: /^Notifications/ });
		await expect(bell).toHaveAccessibleName(/unread/, { timeout: 15_000 });
		await expect.poll(() => received.some((r) => r.title === 'e2e_rocket failed')).toBe(true);
		await bell.click();
		const tray = page.getByRole('region', { name: 'Notifications' });
		await expect(tray).toContainText('e2e_rocket failed');
		await tray.getByRole('button', { name: 'Mark all read' }).click();
		await expect(tray).toContainText('All read');
		await expect(bell).toHaveAccessibleName('Notifications');

		// Switched off, the channel sends nothing more.
		await page.keyboard.press('Escape');
		await row.getByRole('checkbox', { name: 'Phone switched on' }).uncheck();
		await expect(row).toHaveClass(/off/);
		const before = received.length;
		await page.request.post(`${SIM}/api/start`, { data: { name: 'e2e_quiet', minutes: 30 } });
		await expect
			.poll(async () => (await (await page.request.get('/api/printers')).json())[0]?.state?.task)
			.toBe('e2e_quiet');
		await page.request.post(`${SIM}/api/fail`);
		await expect
			.poll(async () =>
				(await (await page.request.get('/api/notifications')).json()).items.some(
					(n: { title: string }) => n.title === 'e2e_quiet failed'
				)
			)
			.toBe(true);
		expect(received.length).toBe(before);
	} finally {
		server.close();
	}
});
