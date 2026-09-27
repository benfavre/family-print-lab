import {
	chromium,
	expect,
	test,
	type APIRequestContext,
	type BrowserContext,
	type Page
} from '@playwright/test';

// Access from other devices. The test server lists printlab.local in ALLOWED_HOSTS; a second browser
// resolves that name to 127.0.0.1, so its requests carry a non-local Host header like a phone's would.
const ready = (page: Page) => page.locator('html[data-ready]').waitFor({ state: 'attached' });
const PASSWORD = 'correct horse';
const LAN = 'http://printlab.local:4173';

/** An API status as the other device would get it, with its cookies (Node has no host mapping). */
async function lanStatus(request: APIRequestContext, context: BrowserContext, path: string) {
	const cookie = (await context.cookies(LAN)).map((c) => `${c.name}=${c.value}`).join('; ');
	const res = await request.get(`http://127.0.0.1:4173${path}`, {
		headers: { host: 'printlab.local:4173', ...(cookie ? { cookie } : {}) },
		maxRedirects: 0
	});
	return res.status();
}

test.beforeEach(async ({ context }) => {
	await context.addInitScript(() => sessionStorage.setItem('print-lab-profile', 'all'));
});

test.afterAll(async ({ request }) => {
	// Leave the app as the other specs expect it: only this computer, nobody logged in.
	await request.delete('/api/auth/password', { data: { current: PASSWORD } });
});

test('another device needs the household password; this computer stays open', async ({
	page,
	request
}) => {
	const phone = await chromium.launch({
		channel: 'chrome',
		args: ['--host-resolver-rules=MAP printlab.local 127.0.0.1']
	});
	try {
		const phoneContext = await phone.newContext();
		const lan = await phoneContext.newPage();
		await lan.addInitScript(() => sessionStorage.setItem('print-lab-profile', 'all'));

		// No password yet: the other device is told to set one on the computer.
		await lan.goto(`${LAN}/jobs`);
		await expect(
			lan.getByRole('heading', { name: 'Set a password on the computer first' })
		).toBeVisible();
		expect(await lanStatus(request, phoneContext, '/api/workspace')).toBe(403);

		// On the computer: the settings say why, and take a password.
		await page.goto('/integrations');
		await ready(page);
		const section = page.locator('#access');
		await expect(section.locator('.warn')).toContainText('ALLOWED_HOSTS=printlab.local');
		await section.getByLabel('Household password').fill(PASSWORD);
		await section.getByLabel('Type it again').fill(PASSWORD);
		await section.getByRole('button', { name: 'Set password' }).click();
		await expect(section.locator('.state')).toHaveText('On · password');

		// The other device logs in and lands where it was going.
		await lan.goto(`${LAN}/jobs`);
		await expect(lan).toHaveURL(/\/login\?next=%2Fjobs$/);
		expect(await lanStatus(request, phoneContext, '/api/workspace')).toBe(401);
		await lan.getByLabel('Password').fill('not it');
		await lan.getByRole('button', { name: 'Log in' }).click();
		await expect(lan.getByRole('alert')).toHaveText('That password or PIN is not right.');
		await lan.getByLabel('Password').fill(PASSWORD);
		await lan.getByRole('button', { name: 'Log in' }).click();
		await expect(lan).toHaveURL(`${LAN}/jobs`);
		await ready(lan);
		expect(await lanStatus(request, phoneContext, '/api/workspace')).toBe(200);

		// The computer sees it in the signed-in devices, and is still open itself.
		await page.reload();
		await ready(page);
		const devices = section.getByRole('list', { name: 'Signed-in devices' }).locator('li');
		await expect(devices).toHaveCount(1);
		await expect(devices.first()).toContainText('Household password');

		// Logging out on the other device sends it back to the login page.
		await lan.getByRole('button', { name: 'Log out' }).click();
		await expect(lan).toHaveURL(/\/login$/);
		expect(await lanStatus(request, phoneContext, '/api/workspace')).toBe(401);

		// Turning it off again, on the computer.
		await section.getByRole('button', { name: 'Turn off' }).click();
		await section.getByLabel(/Current password/).fill(PASSWORD);
		await section.getByRole('button', { name: 'Turn off' }).last().click();
		await expect(section.locator('.state')).toHaveText('Only this computer');
	} finally {
		await phone.close();
	}
});
