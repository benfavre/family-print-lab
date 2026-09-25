import { expect, test } from '@playwright/test';

const SIM = 'http://127.0.0.1:18881';

test('link to the cloud, and a grown-up answers a kid’s request from the phone', async ({
	page
}) => {
	const ws = await page.request.get('/api/workspace').then((r) => r.json());
	if (!ws.parentPin) await page.request.post('/api/parent/pin', { data: { pin: '2468' } });
	await page.request.post('/api/profiles', {
		data: { name: 'Nina', color: 'green', age: 9, kid: 'junior' }
	});

	// Link this computer from the Family page.
	await page.goto('/family');
	await page.getByRole('button', { name: 'Continue as Everyone' }).click();
	await page.getByRole('button', { name: 'Link to Print Lab Cloud' }).click();
	const code = (await page.getByTestId('cloud-code').textContent())!.trim();
	expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
	// …a grown-up enters the code on the cloud site:
	expect((await page.request.post(`${SIM}/sim/link`, { data: { code } })).status()).toBe(200);
	await expect(page.locator('.phone')).toContainText('Online · linked to parent@example.com');

	// A kid asks for a print.
	await page.getByRole('button', { name: 'Lock screen or switch profile' }).click();
	await page.getByRole('button', { name: 'Start kid mode for Nina' }).click();
	await page.getByRole('link', { name: /Drawing stencil/ }).click();
	const save = page.getByRole('button', { name: 'Save it! ✨' });
	await expect(save).toBeEnabled({ timeout: 30_000 });
	await save.click();
	await page.getByRole('button', { name: 'It’s a present 🎁' }).click();
	await page.getByRole('button', { name: '🙋 Ask a grown-up to print it' }).click();
	await expect(page.getByText('Waiting for a grown-up')).toBeVisible();

	// The cloud receives it…
	let request: { id: string; kid: string; status: string; message: string } | undefined;
	await expect
		.poll(async () => {
			const state = await page.request.get(`${SIM}/sim/state`).then((r) => r.json());
			request = state.requests.find((r: { kid: string }) => r.kid === 'Nina');
			return request?.status;
		})
		.toBe('Waiting');
	expect(request!.message).toBe('It’s a present 🎁');

	// …and the answer from the phone reaches the kid's screen.
	const answer = await page.request
		.post(`${SIM}/sim/decide`, {
			data: { requestId: request!.id, decision: 'approve', reply: 'Saturday morning!' }
		})
		.then((r) => r.json());
	expect(answer).toEqual({ ok: true });
	await expect(page.getByText('Yes! It’s coming soon')).toBeVisible();
	await expect(page.getByText('“Saturday morning!”')).toBeVisible();

	// Back as a grown-up: the job is queued, and unlinking works.
	await page.getByRole('button', { name: '🔒 Grown-ups' }).click();
	await page.getByLabel('Parent PIN').fill('2468');
	await page.getByRole('button', { name: 'Leave kid mode' }).click();
	await page.getByRole('button', { name: 'Continue as Everyone' }).click();
	const after = await page.request.get('/api/workspace').then((r) => r.json());
	expect(after.jobs.some((j: { notes: string }) => j.notes.startsWith('Asked for by Nina'))).toBe(
		true
	);
	expect(after.activity.some((a: { message: string }) => /from the phone/.test(a.message))).toBe(
		true
	);
	await page.goto('/family');
	await page.getByRole('button', { name: 'Unlink', exact: true }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Unlink' }).click();
	await expect(page.getByRole('button', { name: 'Link to Print Lab Cloud' })).toBeVisible();
	const state = await page.request.get(`${SIM}/sim/state`).then((r) => r.json());
	expect(state.devices).toHaveLength(0);
});
