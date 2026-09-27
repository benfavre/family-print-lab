import { expect, test, type Page } from '@playwright/test';
import { createFakePlug, type FakePlugServer } from '../src/lib/server/printer/sim/features/power';

// Integrations → Home automation with a fake Tasmota plug (the simulator's, in this process): add a
// plug to the simulated printer, test it, switch it from the printer page, turn on Home Assistant
// access and metrics, and make a token that is shown once.
const ready = (page: Page) => page.locator('html[data-ready]').waitFor({ state: 'attached' });

const relay = { on: true, set: (on: boolean) => void (relay.on = on) };
let fake: FakePlugServer;
test.beforeAll(async () => {
	fake = await createFakePlug({ plug: relay, user: 'admin', password: 'plug-secret' });
});
test.afterAll(() => fake.close());
test.beforeEach(async ({ context }) => {
	await context.addInitScript(() => sessionStorage.setItem('print-lab-profile', 'all'));
});

test('Home automation: a smart plug, the Power panel, Home Assistant access and metrics', async ({
	page
}) => {
	await page.goto('/integrations');
	await ready(page);
	const section = page.locator('#home-automation');
	const row = section.locator('li[data-printer]').first();
	await expect(row).toContainText('No smart plug.');
	const printerId = await row.getAttribute('data-printer');

	await row.getByRole('button', { name: 'Add a plug' }).click();
	const form = page.getByRole('dialog', { name: /Add the plug of/ });
	await form.getByLabel('Kind of plug').selectOption('tasmota');
	await form.getByLabel('Address of the plug').fill(`http://127.0.0.1:${fake.port}`);
	await form.getByLabel('User name').fill('admin');
	await form.getByLabel('Password').fill('plug-secret');
	await form.getByLabel(/Switch it off after a print/).check();
	await form.getByRole('button', { name: 'Add plug' }).click();
	await expect(row).toContainText('Tasmota');

	// The password is write-only.
	const listed = await (await page.request.get('/api/plugs')).text();
	expect(listed).not.toContain('plug-secret');
	expect(listed).toContain('"hasPassword":true');

	await row.getByRole('button', { name: 'Test' }).click();
	await expect(row.locator('.result')).toContainText('it is on');

	// The printer page: the Power panel switches the plug off, after asking.
	await page.goto(`/printers/${printerId}`);
	await ready(page);
	const panel = page.locator('section.panel', {
		has: page.getByRole('heading', { name: 'Power' })
	});
	const confirm = page.locator('#confirm');
	await expect(panel.locator('dd')).toHaveText(/^On/);
	await panel.getByRole('button', { name: 'Switch off' }).click();
	await confirm.getByRole('button', { name: 'Switch off' }).click();
	await expect(panel.locator('dd')).toHaveText(/^Off/);
	expect(relay.on).toBe(false);
	await panel.getByRole('button', { name: 'Switch on' }).click();
	await confirm.getByRole('button', { name: 'Switch on' }).click();
	await expect.poll(() => relay.on).toBe(true);

	// Home Assistant access and metrics, and a token shown once.
	await page.goto('/integrations');
	await ready(page);
	expect((await page.request.get('/metrics')).status()).toBe(404);
	await section.getByLabel('Let Home Assistant read the printers').check();
	await section.getByLabel('Prometheus metrics').check();
	await expect(section.locator('code.url')).toHaveCount(2);
	await section.getByRole('button', { name: 'Create a token' }).click();
	const token = await section.locator('.token code').textContent();
	expect(token).toMatch(/^plab_/);

	// This computer reads them without the token.
	const printers = await (await page.request.get('/api/ha/printers')).json();
	expect(printers.printers[0]).toMatchObject({ id: printerId, power: true });
	const metrics = await page.request.get('/metrics');
	expect(metrics.headers()['content-type']).toContain('version=0.0.4');
	expect(await metrics.text()).toContain('printlab_printer_up{');
	const settings = await (await page.request.get('/api/ha/settings')).text();
	expect(settings).not.toContain(token!);

	// Clean up for the other specs.
	await page.reload();
	await ready(page);
	await row.getByRole('button', { name: 'Edit' }).click();
	await page.locator('#plug-form').getByRole('button', { name: 'Remove plug' }).click();
	await page.locator('#confirm').getByRole('button', { name: 'Remove plug' }).click();
	await expect(row).toContainText('No smart plug.');
});
