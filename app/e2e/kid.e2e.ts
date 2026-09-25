import { expect, test } from '@playwright/test';

test('a kid makes a name sign and asks; a grown-up unlocks with the PIN and says yes', async ({
	page
}) => {
	// A grown-up sets the parent PIN and turns on kid mode for a new maker.
	await page.goto('/family');
	await page.getByRole('button', { name: 'Continue as Everyone' }).click();
	await page.getByLabel('Parent PIN').fill('2468');
	await page.getByLabel('Type it again').fill('2468');
	await page.getByRole('button', { name: 'Set PIN' }).click();
	await expect(page.getByText('Parent PIN set.')).toBeVisible();
	await page.getByRole('button', { name: '＋ Add person' }).click();
	await page.getByLabel('Name or nickname').fill('Kiki');
	await page.getByRole('combobox', { name: /^Kid mode/ }).selectOption('little');
	await page.getByRole('button', { name: 'Add person', exact: true }).click();
	await expect(page.getByText('Kiki joined the family.')).toBeVisible();

	// The kid starts kid mode from the profile picker.
	await page.getByRole('button', { name: 'Lock screen or switch profile' }).click();
	await page.getByRole('button', { name: 'Start kid mode for Kiki' }).click();
	await expect(page).toHaveURL(/\/kid$/);
	await expect(page.getByRole('heading', { name: 'What shall we make?' })).toBeVisible();
	// Little makers do not get the small keychain.
	await expect(page.getByRole('link', { name: /Keychain/ })).toHaveCount(0);

	// The rest of the app stays out of reach, pages and API alike.
	await page.goto('/jobs');
	await expect(page).toHaveURL(/\/kid$/);
	const status = (method: string, url: string, body?: unknown) =>
		page.evaluate(
			async ([method, url, body]) =>
				(
					await fetch(url as string, {
						method: method as string,
						headers: body ? { 'content-type': 'application/json' } : undefined,
						body: body ? JSON.stringify(body) : undefined
					})
				).status,
			[method, url, body]
		);
	expect(await status('POST', '/api/printer/control', { action: 'stop' })).toBe(403);
	expect(await status('GET', '/api/export')).toBe(403);
	expect(await status('PATCH', '/api/profiles/son', { kid: null, version: 1 })).toBe(403);

	// Make a name sign.
	await page.getByRole('link', { name: /Name sign/ }).click();
	const name = page.getByLabel('What should it say?');
	await expect(name).toHaveAttribute('placeholder', 'Kiki');
	await name.fill('KIKI 🦄');
	await page.getByText('Bubble').click();
	const save = page.getByRole('button', { name: 'Save it! ✨' });
	await expect(save).toBeEnabled({ timeout: 30_000 });
	await save.click();
	await expect(page.getByRole('heading', { level: 1, name: 'Name sign: KIKI' })).toBeVisible();
	await expect(page.getByText('Ready to ask')).toBeVisible();

	// Ask a grown-up.
	await page.getByRole('button', { name: 'Please! 🙏' }).click();
	await page.getByRole('button', { name: '🙋 Ask a grown-up to print it' }).click();
	await expect(page.getByText('Waiting for a grown-up')).toBeVisible();
	await page.getByRole('link', { name: 'Home' }).click();
	await expect(page.locator('.thing')).toContainText('Waiting for a grown-up');

	// Leaving needs the PIN.
	await page.getByRole('button', { name: '🔒 Grown-ups' }).click();
	await page.getByLabel('Parent PIN').fill('0000');
	await page.getByRole('button', { name: 'Leave kid mode' }).click();
	await expect(page.getByRole('alert')).toHaveText('That PIN is not right.');
	await page.getByLabel('Parent PIN').fill('2468');
	await page.getByRole('button', { name: 'Leave kid mode' }).click();
	await expect(page.getByRole('heading', { name: 'Who’s making today?' })).toBeVisible();

	// The grown-up sees the request and says yes.
	await page.getByRole('button', { name: 'Continue as Everyone' }).click();
	await page.getByRole('link', { name: /1 print request/ }).click();
	await expect(page).toHaveURL(/\/family#requests$/);
	const request = page.locator('.request');
	await expect(request).toContainText('Kiki wants to print Name sign: KIKI');
	await expect(request).toContainText('“Please! 🙏”');
	await request.getByLabel('Answer to Kiki').fill('Tonight!');
	await request.getByRole('button', { name: 'Yes, queue it' }).click();
	await expect(page.getByText('No requests waiting.')).toBeVisible();
	const workspace = await page.request.get('/api/workspace').then((r) => r.json());
	const job = workspace.jobs.find((j: { notes: string }) =>
		j.notes.startsWith('Asked for by Kiki')
	);
	expect(job).toMatchObject({ status: 'Queued', notes: 'Asked for by Kiki: “Please! 🙏”' });
	expect(job.modelVersionId).toBeTruthy();

	// Back in kid mode, the answer is there.
	await page.getByRole('button', { name: 'Lock screen or switch profile' }).click();
	await page.getByRole('button', { name: 'Start kid mode for Kiki' }).click();
	await expect(page.locator('.thing')).toContainText('Yes! It’s coming soon');
	await page.locator('.thing').click();
	await expect(page.getByText('“Tonight!”')).toBeVisible();
});
