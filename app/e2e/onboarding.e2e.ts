import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { expect, test } from '@playwright/test';

// The first run: a second copy of the built app over an empty database (no legacy import, no printer
// in the environment) and its own simulated X2D, so the shared e2e server and printer are untouched.
// Fresh database → setup guide → simulated printer added → family → first job sent.
const APP = 'http://127.0.0.1:4175';
const SIM_CONTROL = 'http://127.0.0.1:18681';
const DIR = '.e2e/welcome';
const children: ChildProcess[] = [];

async function waitFor(url: string, ms = 60_000) {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		try {
			if ((await fetch(url)).status < 500) return;
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`${url} did not start`);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
	fs.rmSync(DIR, { recursive: true, force: true });
	fs.mkdirSync(DIR, { recursive: true });
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([k]) => !/^(BAMBU_|PRINTLAB_PRINTERS)/.test(k))
	);
	children.push(
		spawn(
			'node',
			[
				'--import',
				'tsx',
				'tools/printer-sim.ts',
				'--fleet',
				'N6',
				'--port',
				'18851',
				'--ftp-port',
				'19011',
				'--control',
				'18681',
				'--speed',
				'120',
				'--fail-rate',
				'0'
			],
			{ stdio: 'ignore', env }
		),
		spawn('node', ['.e2e/build'], {
			stdio: 'ignore',
			env: {
				...env,
				HOST: '127.0.0.1',
				PORT: '4175',
				DATABASE_URL: `${DIR}/fresh.db`,
				BACKUP_DIR: `${DIR}/backups`,
				LEGACY_IMPORT: '/nonexistent/legacy.json',
				LAB_AI: 'off',
				BODY_SIZE_LIMIT: '110M',
				CLAUDE_BIN: '/nonexistent/claude',
				CODEX_BIN: '/nonexistent/codex',
				PRINTLAB_PROFILES_DIR: 'src/lib/server/profiles/__fixtures__/vendor'
			}
		})
	);
	await Promise.all([waitFor(SIM_CONTROL), waitFor(APP)]);
});

test.afterAll(() => {
	for (const child of children) child.kill();
});

test('a fresh lab opens the setup guide, adds the simulator and sends a first job', async ({
	page
}) => {
	const workspace = () => page.request.get(`${APP}/api/workspace`).then((r) => r.json());
	expect((await (await page.request.get(`${APP}/api/onboarding`)).json()).firstRun).toBe(true);

	// Nobody in the family and no printer: the guide opens by itself.
	await page.goto(`${APP}/`);
	// (The first integrations check runs the command-line tools, which can keep the server busy.)
	await expect(page).toHaveURL(/\/welcome$/, { timeout: 20_000 });
	await expect(page.getByRole('heading', { name: 'Welcome to Family Print Lab' })).toBeVisible();
	await page.getByRole('button', { name: 'Let’s start' }).click();

	// Printer: the trade-offs are explained before anything is asked.
	await expect(page).toHaveURL(/step=printer/);
	await expect(page.getByRole('heading', { name: 'Connect your printer' })).toBeVisible();
	await expect(page.getByRole('note')).toContainText('Bambu Handy');
	await expect(page.getByRole('note')).toContainText('To switch back');
	// Find printers hears the P1S simulator that announces itself over SSDP (playwright.config.ts) and
	// fills in what it announced; its ports are not announced, so this test adds its own X2D by hand.
	await page.getByRole('button', { name: 'Find printers' }).click();
	const p1s = page.locator('.found li', { hasText: 'P1S' });
	await expect(p1s).toContainText('127.0.0.1', { timeout: 15_000 });
	await p1s.getByRole('button', { name: 'Use this one' }).click();
	const form = page.getByRole('form', { name: 'Printer details' });
	await expect(form.getByLabel('Serial number')).toHaveValue('SIM-P1S-0001');
	await expect(form.getByLabel('IP address')).toHaveValue('127.0.0.1');
	await page.getByRole('button', { name: 'Enter details by hand' }).click();
	await expect(form.getByLabel('Serial number')).toHaveValue('');
	await form.getByLabel('Name').fill('Garage X2D');
	await form.getByLabel('IP address').fill('127.0.0.1');
	await form.getByLabel('Serial number').fill('SIM-X2D-0001');
	await form.getByLabel('Access code').fill('12345678');
	await form.getByRole('button', { name: 'Show advanced settings' }).click();
	await form.getByLabel('MQTT port').fill('18851');
	await form.getByLabel('File port').fill('19011');
	await form.getByLabel('Encrypted (TLS)').uncheck();
	await form.getByLabel('This is the printer simulator').check();
	await form.getByRole('button', { name: 'Test the connection' }).click();
	await expect(form.locator('.result')).toContainText('Connected', { timeout: 15_000 });
	await form.getByRole('button', { name: 'Add printer' }).click();
	const added = page.getByRole('list', { name: 'Printers added' });
	await expect(added).toContainText('Garage X2D');
	await expect(added).toContainText('the simulator', { timeout: 15_000 });
	await page.getByRole('button', { name: 'Next' }).click();

	// Tools: optional cards with status, including the cloud link, which is off.
	await expect(page.getByRole('heading', { name: 'Choose your tools' })).toBeVisible();
	await expect(page.locator('[data-integration="cloud"]')).toContainText('Not ready');
	await expect(page.locator('[data-integration="claude-code"] .state')).toHaveText('Not ready');
	await page.getByRole('button', { name: 'Next' }).click();

	// Family: a grown-up, then a child in kid mode (which asks for the parent PIN on the spot).
	await expect(page.getByRole('heading', { name: 'Who makes things here?' })).toBeVisible();
	const person = page.getByRole('form', { name: 'Add a person' });
	await person.getByLabel('Name or nickname').fill('Alex');
	await person.getByRole('button', { name: 'Add person' }).click();
	const people = page.getByRole('list', { name: 'Family profiles' });
	await expect(people).toContainText('Alex');
	await person.getByLabel('Name or nickname').fill('Mia');
	await person.getByLabel('Kid mode').selectOption('junior');
	await person.getByLabel('Parent PIN').fill('2468');
	await person.getByLabel('PIN again').fill('2468');
	await person.getByRole('button', { name: 'Add person' }).click();
	await expect(people).toContainText('Mia');
	await expect(people).toContainText('Junior maker');
	await page.getByRole('button', { name: 'Next' }).click();

	// Done: the guide is marked finished, and a sliced file becomes the first print.
	await expect(page.getByRole('heading', { name: 'You are all set' })).toBeVisible();
	await expect(page.getByRole('list', { name: 'What is set up' })).toContainText(
		'Garage X2D added'
	);
	await expect
		.poll(async () => (await (await page.request.get(`${APP}/api/onboarding`)).json()).completedAt)
		.toBeTruthy();
	// A file that is not a sliced project is turned away before anything is made.
	await page.getByLabel('Sliced file for the first print').setInputFiles({
		name: 'cable-clip.stl',
		mimeType: 'model/stl',
		buffer: Buffer.from('solid clip\nendsolid clip\n')
	});
	await expect(page.getByText('Choose the sliced file (.gcode.3mf)')).toBeVisible();
	await page
		.getByLabel('Sliced file for the first print')
		.setInputFiles('src/lib/server/__fixtures__/cable-clip.gcode.3mf');
	const send = page.getByRole('dialog', { name: /^Print / });
	await expect(send).toContainText('is ready', { timeout: 15_000 });
	await send.getByRole('button', { name: 'Send and start printing' }).click();
	await expect
		.poll(
			async () => {
				const ws = await workspace();
				const job = ws.jobs.find((j: { projectId: string }) =>
					ws.projects.some(
						(p: { id: string; title: string }) => p.id === j.projectId && p.title === 'First print'
					)
				);
				return job && { status: job.status, printer: job.printerId === ws.printers[0].id };
			},
			{ timeout: 30_000 }
		)
		.toEqual({ status: 'Printing', printer: true });
	const firstPrints = (await workspace()).projects.filter(
		(p: { title: string }) => p.title === 'First print'
	);
	expect(firstPrints).toHaveLength(1);

	// Set up now: a new tab shows the profile chooser, not the guide.
	const tab = await page.context().newPage();
	await tab.goto(`${APP}/`);
	await expect(tab.getByRole('heading', { name: 'Who’s making today?' })).toBeVisible();
	await expect(tab.getByRole('button', { name: 'Continue as Alex' })).toBeVisible();
	await expect(tab).not.toHaveURL(/welcome/);
});
