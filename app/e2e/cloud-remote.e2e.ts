import { expect, test } from '@playwright/test';
import { createHmac, hkdfSync, randomUUID } from 'node:crypto';

const SIM = 'http://127.0.0.1:18881';
const PRINTER_SIM = 'http://127.0.0.1:18661';

test('the phone sees every printer and pauses a print with the phone key', async ({ page }) => {
	const ws = await page.request.get('/api/workspace').then((r) => r.json());
	if (!ws.parentPin) await page.request.post('/api/parent/pin', { data: { pin: '2468' } });

	// Link this computer (the phone e2e may have linked and unlinked before).
	await page.goto('/family');
	await page.getByRole('button', { name: 'Continue as Everyone' }).click();
	await page.getByRole('button', { name: 'Link to Print Lab Cloud' }).click();
	const code = (await page.getByTestId('cloud-code').textContent())!.trim();
	expect((await page.request.post(`${SIM}/sim/link`, { data: { code } })).status()).toBe(200);
	await expect(page.locator('.phone')).toContainText('Online · linked to parent@example.com');

	// Share printer status, then show the phone key behind the parent PIN.
	await page.getByLabel(/Share printer status/).check();
	await page.getByRole('button', { name: 'Show phone key' }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('Parent PIN').fill('2468');
	await dialog.getByRole('button', { name: 'Show key' }).click();
	await expect(dialog.getByRole('img', { name: 'QR code with the phone key' })).toBeVisible();
	await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
	await dialog.getByRole('button', { name: 'Copy the link instead' }).click();
	const link: string = await page.evaluate(() => navigator.clipboard.readText());
	expect(link).toMatch(/^http:\/\/127\.0\.0\.1:18881\/phone-key#k=[\w-]{43}$/);
	await dialog.getByRole('button', { name: 'Done' }).click();

	// Remote control needs the PIN too.
	await page.getByLabel(/Allow pause, resume and stop/).check();
	await dialog.getByLabel('Parent PIN').fill('2468');
	await dialog.getByRole('button', { name: 'Turn on' }).click();
	await expect(page.getByLabel(/Allow pause, resume and stop/)).toBeChecked();

	// The cloud gets both printers, sealed, and control allowed.
	await expect
		.poll(async () => {
			const state = await page.request.get(`${SIM}/sim/state`).then((r) => r.json());
			return state.printers?.control && state.printers.printers?.length;
		})
		.toBeGreaterThanOrEqual(1);
	const state = await page.request.get(`${SIM}/sim/state`).then((r) => r.json());
	for (const p of state.printers.printers)
		expect(Object.keys(p).sort()).toEqual(['event', 'id', 'sealed', 'state']);

	// Start a print on the simulated X2D, then pause it as the phone would.
	await page.request.post(`${PRINTER_SIM}/api/start`, { data: { minutes: 30 } });
	const statuses = await page.request.get('/api/printers').then((r) => r.json());
	const x2d = statuses.find(
		(p: { model: string; connected: boolean }) => p.model === 'N6' && p.connected
	);
	await expect
		.poll(
			async () =>
				(await page.request.get(`/api/printers/${x2d.id}`).then((r) => r.json())).state?.gcodeState
		)
		.toBe('RUNNING');
	const key = Buffer.from(link.split('#k=')[1], 'base64url');
	const mac = Buffer.from(hkdfSync('sha256', key, 'family-print-lab', 'phone mac v1', 32));
	const command = { commandId: randomUUID(), printerId: x2d.id, action: 'pause', at: Date.now() };
	const signed = {
		...command,
		mac: createHmac('sha256', mac)
			.update(`${command.commandId}|${command.printerId}|${command.action}|${command.at}`)
			.digest('hex')
	};
	expect(
		await page.request.post(`${SIM}/sim/control`, { data: signed }).then((r) => r.json())
	).toEqual({ ok: true });
	// Replayed: refused.
	expect(
		await page.request.post(`${SIM}/sim/control`, { data: signed }).then((r) => r.json())
	).toMatchObject({ ok: false });
	const after = await page.request.get('/api/workspace').then((r) => r.json());
	expect(
		after.activity.some((a: { message: string }) => /^Paused .+ from the phone/.test(a.message))
	).toBe(true);

	// Tidy up for other tests.
	await page.request.post(`${PRINTER_SIM}/api/stop`, { data: {} });
	await page.request.post('/api/cloud/unlink', { data: {} });
});
