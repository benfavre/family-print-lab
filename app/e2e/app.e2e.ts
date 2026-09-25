import { expect, test, type Page } from '@playwright/test';

const SIM = 'http://127.0.0.1:18661';
// Waits until the app has hydrated, so keyboard shortcuts and handlers are live.
const ready = (page: Page) => page.locator('html[data-ready]').waitFor({ state: 'attached' });
const workspace = (page: Page) => page.request.get('/api/workspace').then((r) => r.json());

test.describe.configure({ mode: 'serial' });

test('home shows the migrated workspace with live printer status', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'What shall we make?' })).toBeVisible();
	await expect(page.locator('.idea-card')).toHaveCount(16);
	await expect(page.locator('.printer-chip')).toContainText('Simulator');
	await expect(page.locator('.stat').first()).toContainText('Idea');
});

test('creating a project opens it in the split view, and stale edits are refused', async ({
	page
}) => {
	await page.goto('/');
	await page.getByRole('button', { name: '＋ New idea' }).click();
	// Editors open as floating panels (like mail drafts), not modals.
	const dialog = page.getByRole('dialog', { name: /A new idea/ });
	await dialog.getByLabel('Project name').fill('E2E cable clip');
	await dialog.getByLabel('Category').selectOption('Office');
	// Long text can be written in a larger editor; Esc returns to the form without closing it.
	await dialog.getByRole('button', { name: 'Expand The idea' }).click();
	await page.locator('.text-expanded textarea').fill('Holds four cables.\nScrews under the desk.');
	await page.keyboard.press('Escape');
	await expect(page.locator('.text-expanded')).toHaveCount(0);
	await expect(dialog.getByLabel('The idea', { exact: true })).toHaveValue(
		'Holds four cables.\nScrews under the desk.'
	);
	await dialog.getByRole('button', { name: 'Add idea' }).click();
	await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
	await expect(page.getByRole('heading', { level: 1, name: 'E2E cable clip' })).toBeVisible();
	await expect(page.locator('.side-row.current')).toContainText('E2E cable clip');
	await expect(page.locator('.checklist li')).toHaveCount(6);

	// Another client edits first: this tab's version is now stale, so the server refuses with 409.
	const id = page.url().split('/').pop()!;
	const project = (await workspace(page)).projects.find((p: { id: string }) => p.id === id);
	expect(
		(
			await page.request.patch(`/api/projects/${id}`, {
				data: { version: project.version, notes: 'first' }
			})
		).status()
	).toBe(200);
	const stale = await page.request.patch(`/api/projects/${id}`, {
		data: { version: project.version, notes: 'stale' }
	});
	expect(stale.status()).toBe(409);
	expect((await stale.json()).error).toMatch(/changed somewhere else/);
});

test('grid morphs into the sidebar; the sidebar searches, pins and navigates by keyboard', async ({
	page
}) => {
	await page.goto('/');
	await page.locator('.idea-card', { hasText: 'Desk pen station' }).click();
	await expect(page).toHaveURL(/\/projects\/idea-04$/);
	await expect(page.locator('.sidebar')).toBeVisible();
	await ready(page);

	await page.keyboard.press('/');
	await expect(page.locator('.side-search input')).toBeFocused();
	await page.keyboard.type('sign');
	await expect(page.locator('.side-row')).toHaveCount(await page.locator('.side-row').count());
	await expect(page.locator('.side-title mark').first()).toHaveText('sign');
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('Enter');
	await expect(page).not.toHaveURL(/idea-04$/);
	await page.locator('.side-search input').press('Escape');
	await expect(page.locator('.side-search input')).toHaveValue('');

	const row = page.locator('.side-row', { hasText: 'Entryway catchall' });
	await row.hover();
	await row.getByRole('button', { name: /Pin Entryway catchall/ }).click();
	await expect(page.locator('.side-section h3').first()).toContainText('Pinned');
	await page.goto('/');
	await expect(page.locator('.idea-card').first()).toContainText('Entryway catchall');
});

test('the context menu changes progress and asks before deleting', async ({ page }) => {
	await page.goto('/');
	const card = page.locator('.idea-card', { hasText: 'Adapter sorting tray' });
	await card.click({ button: 'right' });
	const menu = page.getByRole('menu', { name: 'Actions' });
	await expect(menu).toBeVisible();
	await menu.getByRole('menuitemradio', { name: 'Planned' }).click();
	await expect(card.locator('.status-pill')).toHaveText('Planned');

	await card.click({ button: 'right' });
	await menu.getByRole('menuitem', { name: 'Delete…' }).click();
	await expect(page.locator('#confirm')).toBeVisible();
	await page.getByRole('button', { name: 'Keep it' }).click();
	await expect(card).toBeVisible();
});

test('a print job runs its lifecycle and charges the spool; a second tab updates live', async ({
	page,
	context
}) => {
	const other = await context.newPage();
	await other.goto('/filament');
	const spool = other.locator('.spool-card', { hasText: 'Sunset orange' });
	await expect(spool).toContainText('930 g');

	await page.goto('/projects/idea-09');
	await page.getByRole('button', { name: '＋ Queue a print' }).click();
	const dialog = page.getByRole('dialog', { name: /Queue a print/ });
	const spoolSelect = dialog.getByLabel(/^Spool/);
	await spoolSelect.selectOption(
		(await spoolSelect.locator('option', { hasText: 'Sunset orange' }).getAttribute('value'))!
	);
	await dialog.getByLabel('Filament (g)').fill('70');
	await dialog.getByRole('button', { name: 'Add to queue' }).click();
	const job = page.locator('.job-card', { hasText: 'Queued' }).first();
	await job.getByRole('button', { name: 'Start' }).click();
	await expect(
		page.locator('.job-card .status-pill', { hasText: 'Printing' }).first()
	).toBeVisible();
	await page
		.locator('.job-card', { hasText: 'Printing' })
		.first()
		.getByRole('button', { name: 'Succeeded' })
		.click();
	await expect(page.locator('.toast').last()).toContainText(/succeeded/i);

	// The other tab never reloaded: the server-sent event brought the new stock in.
	await expect(spool).toContainText('860 g');
	await other.close();
});

test('the simulated printer drives a linked job to completion', async ({ page }) => {
	const ws = await workspace(page);
	const printing = ws.jobs.find((j: { status: string }) => j.status === 'Printing');
	expect(printing).toBeTruthy();
	await page.goto('/printer');
	await expect(page.getByText('SIMULATED PRINTER · FOR DEVELOPMENT')).toBeVisible();
	const started = await page.request.post(`${SIM}/api/start`, {
		// ~6 s at 120× speed: long enough for the page to show it live (updates are throttled to ~1 s).
		data: { name: 'e2e_plate', minutes: 12, slot: '0' }
	});
	expect(started.ok()).toBeTruthy();
	await expect(page.locator('.live-dot', { hasText: /^LIVE/ })).toBeVisible({ timeout: 20_000 });
	await expect(page.locator('.panel', { hasText: 'Current print' })).toContainText(
		'Linked to this job',
		{ timeout: 20_000 }
	);
	await expect
		.poll(
			async () =>
				(await workspace(page)).jobs.find((j: { id: string }) => j.id === printing.id).status,
			{ timeout: 30_000 }
		)
		.toBe('Succeeded');
	const closed = (await workspace(page)).jobs.find((j: { id: string }) => j.id === printing.id);
	expect(closed.printerTask).toBe('e2e_plate');
});

test('the command palette navigates and the backup exports', async ({ page }) => {
	await page.goto('/');
	await ready(page);
	await page.keyboard.press('Control+k');
	await page.getByRole('combobox', { name: /Search projects, views and actions/ }).fill('filament');
	await page.keyboard.press('Enter');
	await expect(page).toHaveURL(/\/filament$/);

	const download = page.waitForEvent('download');
	await page.getByRole('button', { name: /^Menu/ }).click();
	await page.getByRole('menuitem', { name: /Export backup/ }).click();
	const file = await download;
	expect(file.suggestedFilename()).toMatch(/^family-print-lab-\d{4}-\d{2}-\d{2}\.json$/);

	// The theme lives in the same menu; "G then J" jumps to Print jobs.
	await page.getByRole('button', { name: /^Menu/ }).click();
	await page.getByRole('menuitemradio', { name: 'Nebula theme' }).click();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'nebula');
	await page.keyboard.press('Escape');
	await page.locator('main').click({ position: { x: 5, y: 5 } });
	await page.keyboard.press('g');
	await page.keyboard.press('j');
	await expect(page).toHaveURL(/\/jobs$/);
});

test('security: foreign hosts and cross-site writes are refused, and pages carry a strict CSP', async ({
	page,
	request
}) => {
	expect(
		(await request.get('/api/workspace', { headers: { host: 'evil.example' } })).status()
	).toBe(403);
	expect(
		(
			await request.post('/api/projects', { headers: { origin: 'https://evil.example' }, data: {} })
		).status()
	).toBe(403);
	const response = await page.goto('/');
	const csp = response!.headers()['content-security-policy'] ?? '';
	expect(csp).toMatch(/script-src 'self' 'nonce-/);
	expect(csp).toContain("frame-ancestors 'none'");
	expect(response!.headers()['x-content-type-options']).toBe('nosniff');
});

test('model workbench: live parameters, versions, restore, errors, downloads and mesh tools', async ({
	page
}) => {
	await page.goto('/projects/idea-04');
	await ready(page);
	await page.getByRole('button', { name: '＋ Parametric' }).click();
	await expect(page).toHaveURL(/\/projects\/idea-04\/models\/[0-9a-f-]{36}$/);
	await ready(page);
	const dims = page.locator('.dims.size');
	await expect(dims).toContainText('60.0 × 40.0 × 30.0');

	// Live preview from a parameter, then save it as version 2.
	await page.locator('#param-width').fill('100');
	await page.locator('#param-width').press('Tab');
	await expect(dims).toContainText('100 × 40.0 × 30.0');
	await expect(page.locator('.save-state')).toContainText('Unsaved changes');
	await page.getByLabel('Version note').fill('Wider');
	await page.getByRole('button', { name: 'Save version' }).click();
	await expect(page.locator('.save-state')).toContainText('v2');
	await expect(page.locator('.versions li')).toHaveCount(2);
	await expect(page.locator('.versions li').first()).toContainText('Wider');

	// Broken code is flagged on its line and cannot be saved.
	await page.getByRole('tab', { name: 'Code' }).click();
	await page.locator('.cm-content').click();
	await page.keyboard.press('Control+End');
	await page.keyboard.type('\ncube(');
	await expect(page.locator('.problem.err')).toContainText(/Line \d+/);
	await expect(page.getByRole('button', { name: 'Save version' })).toBeDisabled();

	// Restoring v1 discards the edit after confirming.
	await page
		.locator('.versions li', { hasText: 'v1' })
		.getByRole('button', { name: 'Restore' })
		.click();
	await page.locator('dialog[open]').getByRole('button', { name: 'Restore' }).click();
	await expect(page.locator('.save-state')).toContainText('v1');
	await expect(dims).toContainText('60.0 × 40.0 × 30.0');
	await expect(page.locator('.problem.err')).toHaveCount(0);

	// Downloads: STL and a 3MF that Bambu Studio can open.
	const modelId = page.url().split('/').pop()!;
	const detail = await (await page.request.get(`/api/models/${modelId}`)).json();
	const threeMf = await page.request.get(
		`/api/models/${modelId}/versions/${detail.current.id}/model.3mf?download`
	);
	expect(threeMf.headers()['content-type']).toBe('model/3mf');
	expect((await threeMf.body()).subarray(0, 2).toString()).toBe('PK');

	// Import an STL (raw upload), then scale it with the mesh tools.
	const stl = await page.request.get(
		`/api/models/${modelId}/versions/${detail.current.id}/model.stl`
	);
	const upload = await page.request.post(
		`/api/models/upload?projectId=idea-04&name=Imported&format=stl`,
		{
			headers: { 'content-type': 'application/octet-stream', origin: new URL(page.url()).origin },
			data: await stl.body()
		}
	);
	expect(upload.status()).toBe(200);
	await page.goto(`/projects/idea-04/models/${(await upload.json()).id}`);
	await ready(page);
	await expect(page.locator('.kind-chip')).toHaveText('Mesh');
	await expect(dims).toContainText('60.0 × 40.0 × 30.0');
	await page.getByLabel('Scale percent').fill('50');
	await page.getByRole('button', { name: 'Scale evenly' }).click();
	await expect(dims).toContainText('30.0 × 20.0 × 15.0');
	await expect(page.locator('.versions li')).toHaveCount(2);

	// The print check spots a part too big for the printer and shrinks it to fit in one click.
	const check = page.getByRole('region', { name: 'Ready to print?' });
	await expect(check).toContainText('Ready to print');
	await expect(check).toContainText('Closed and solid');
	await page.getByLabel('Scale percent').fill('1000');
	await page.getByRole('button', { name: 'Scale evenly' }).click();
	await expect(dims).toContainText('300 × 200 × 150');
	await expect(check).toContainText('Too big for the printer');
	await check.getByRole('button', { name: 'Scale to fit' }).click();
	await expect(check).toContainText('Fits on the plate');
	await expect(page.locator('.versions li')).toHaveCount(4);
	await page.keyboard.press('Escape');
	for (let i = 0; i < 2; i++) {
		await page.locator('.viewer').click({ position: { x: 20, y: 200 } });
		await page.keyboard.press('Control+z');
	}
	await expect(dims).toContainText('30.0 × 20.0 × 15.0');

	// Undo/redo step through versions from the keyboard.
	await page.locator('.viewer').click({ position: { x: 20, y: 200 } });
	await page.keyboard.press('Control+z');
	await expect(dims).toContainText('60.0 × 40.0 × 30.0');
	await expect(page.locator('.save-state')).toContainText('v1');
	await page.keyboard.press('Control+Shift+z');
	await expect(dims).toContainText('30.0 × 20.0 × 15.0');

	// Both models show on the project page.
	await page.goto('/projects/idea-04');
	await expect(page.locator('.model-card')).toHaveCount(2);
	// The visualizer shows the project's own latest model instead of a stand-in shape.
	await expect(page.locator('.stage .hud-left')).toContainText('Your model');
	await expect(page.locator('.stage .hud-left')).toContainText('Imported');
});

test('integrations: every tool has a status card, tools can be tested, AI routing can be changed', async ({
	page
}) => {
	await page.goto('/settings');
	await expect(page).toHaveURL(/\/integrations$/);
	await expect(page.getByRole('heading', { name: 'Integrations', level: 1 })).toBeVisible();
	for (const id of ['claude-code', 'codex', 'anthropic-api', 'blender', 'openscad', 'printer'])
		await expect(page.locator(`[data-integration="${id}"]`)).toBeVisible();
	// The CLIs are pointed at missing paths in tests: not ready, with setup steps to copy.
	const claude = page.locator('[data-integration="claude-code"]');
	await expect(claude.locator('.state')).toHaveText('Not ready');
	await expect(claude.locator('.int-setup code').first()).toContainText('claude.ai/install.sh');
	// The built-in engine and the simulated printer are ready and pass their tests.
	const scad = page.locator('[data-integration="openscad"]');
	await scad.getByRole('button', { name: /Test/ }).click();
	await expect(scad.locator('.result')).toContainText('Rendered a test part');
	const printer = page.locator('[data-integration="printer"]');
	await expect(printer.locator('.state')).toHaveText('Ready');
	// Routing a task to another AI is saved.
	await page
		.getByRole('radiogroup', { name: 'Chat' })
		.getByRole('radio', { name: /ChatGPT/ })
		.click();
	await expect
		.poll(async () => (await (await page.request.get('/api/settings')).json()).ai.routing.chat)
		.toBe('codex');
	// The top bar shows the same status at a glance.
	await expect(page.locator('.integrations-pill')).toContainText('Claude');
});

test('bulk: select several projects and change them together in one step', async ({ page }) => {
	await page.goto('/');
	await ready(page);
	const cards = page.locator('.project-card');
	await page.getByRole('button', { name: 'Select', exact: true }).click();
	await cards.nth(0).click();
	await cards.nth(2).click({ modifiers: ['Shift'] });
	await expect(page.locator('.bulk-bar .count')).toContainText('3 selected');
	const ids = await cards.evaluateAll((els) =>
		els.slice(0, 3).map((el) => (el as HTMLElement).dataset.project)
	);
	await page.getByRole('button', { name: 'Category ▾' }).click();
	await page.getByRole('menuitem', { name: /Creative/ }).click();
	await expect(page.locator('.bulk-bar')).toHaveCount(0);
	const ws = await workspace(page);
	for (const id of ids)
		expect(ws.projects.find((p: { id: string }) => p.id === id).category).toBe('Creative');

	// Ctrl+A selects everything visible; Esc clears.
	await page.keyboard.press('Control+a');
	await expect(page.locator('.bulk-bar .count')).toContainText(`${await cards.count()} selected`);
	await page.keyboard.press('Escape');
	await expect(page.locator('.bulk-bar')).toHaveCount(0);

	// All or nothing: a batch naming a missing project changes nothing.
	const bad = await page.request.post('/api/projects/bulk', {
		data: { ids: [...ids, 'missing'], action: 'status', value: 'Done' }
	});
	expect(bad.status()).toBe(404);
	expect(
		(await workspace(page)).projects.filter((p: { status: string }) => p.status === 'Done').length
	).toBe(ws.projects.filter((p: { status: string }) => p.status === 'Done').length);
});

test('jobs and filament: drag a job to start it, filter the queue, weigh a spool in place', async ({
	page
}) => {
	// A queued job to drag.
	const ws = await workspace(page);
	const projectId = ws.projects[0].id;
	const created = await page.request.post('/api/jobs', {
		headers: { origin: 'http://127.0.0.1:4173' },
		data: { projectId, revision: 'Drag me', minutes: 30 }
	});
	const jobId = (await created.json()).id;
	await page.goto('/jobs');
	await ready(page);
	const card = page.locator(`.job-card[data-job="${jobId}"]`);
	const dt = await page.evaluateHandle(() => new DataTransfer());
	await card.dispatchEvent('dragstart', { dataTransfer: dt });
	const zone = page.locator('.drop-zone', { hasText: 'Start printing' });
	await expect(zone).toBeVisible();
	await zone.dispatchEvent('dragover', { dataTransfer: dt });
	await zone.dispatchEvent('drop', { dataTransfer: dt });
	await expect(
		page.locator(`.lane[aria-label="Printing"] .job-card[data-job="${jobId}"]`)
	).toBeVisible();
	await expect(page.locator(`.job-card[data-job="${jobId}"] .job-progress`)).toContainText(
		'done ~'
	);

	// Search narrows the lanes.
	await page.getByLabel('Search print jobs').fill('no such print anywhere');
	await expect(page.locator('.lane .job-card')).toHaveCount(0);
	await page.getByLabel('Search print jobs').fill('');

	// Filament: set what is left without opening the editor.
	await page.goto('/filament');
	await ready(page);
	const spool = page.locator('.spool-card').first();
	await spool.getByRole('button', { name: 'Weigh' }).click();
	await spool.locator('.weigh input').fill('123');
	await spool.getByRole('button', { name: 'Save' }).click();
	await expect(spool).toContainText('123 g');
});

test('editors float like mail drafts: minimize, keep them across pages, expand, restore', async ({
	page
}) => {
	await page.goto('/');
	await ready(page);
	await page.getByRole('button', { name: '＋ New idea' }).click();
	const draft = page.getByRole('dialog', { name: /A new idea/ });
	await draft.getByLabel('Project name').fill('Bird feeder');
	// The title bar follows what is typed, and the page behind stays usable.
	await expect(draft.locator('.fp-title')).toHaveText('A new idea · Bird feeder');
	await page.keyboard.press('Escape');
	await expect(draft.getByLabel('Project name')).toBeHidden();

	await page
		.getByRole('link', { name: /Filament/ })
		.first()
		.click();
	await expect(page).toHaveURL(/\/filament$/);
	await draft.getByRole('button', { name: 'Restore', exact: true }).click();
	await expect(draft.getByLabel('Project name')).toHaveValue('Bird feeder');
	await draft.getByRole('button', { name: 'Expand', exact: true }).click();
	await expect(draft).toHaveClass(/expanded/);
	await draft.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(page.locator('.float-panel')).toHaveCount(0);
});

test('sketch an idea, see it on the project and in the visualizer; AI writing explains when no AI is set up', async ({
	page
}) => {
	// A project without 3D models, so the visualizer falls back to the sketch.
	await page.goto('/projects/idea-09');
	await ready(page);
	await page.getByRole('button', { name: '✎ New sketch' }).click();
	const pad = page.getByRole('dialog', { name: /New sketch/ });
	await pad.getByLabel('Name').fill('Top view');
	const canvas = pad.locator('canvas');
	const b = (await canvas.boundingBox())!;
	await page.mouse.move(b.x + b.width * 0.3, b.y + b.height * 0.3);
	await page.mouse.down();
	await page.mouse.move(b.x + b.width * 0.7, b.y + b.height * 0.6, { steps: 12 });
	await page.mouse.up();
	await pad.getByRole('button', { name: 'Save sketch' }).click();
	const card = page.locator('.sketch-card', { hasText: 'Top view' });
	await expect(card).toBeVisible();
	await expect(card.locator('img')).toHaveJSProperty('complete', true);
	await expect(page.locator('.stage .hud-left')).toContainText('Your sketch');

	// The ✦ menu on text fields: with no AI installed in tests, it says so and changes nothing.
	await page.getByRole('button', { name: 'Edit details' }).click();
	const editor = page.getByRole('dialog', { name: /Edit project/ });
	const idea = editor.getByLabel('The idea', { exact: true });
	const before = await idea.inputValue();
	await editor.getByRole('button', { name: 'Write The idea with AI' }).click();
	await editor.getByRole('menuitem', { name: /Flesh out/ }).click();
	await expect(editor.locator('.ai-suggestion.error')).toContainText(
		/not installed|not available|not ready/i
	);
	await expect(idea).toHaveValue(before);
});

test.describe('on a phone', () => {
	test.use({
		viewport: { width: 390, height: 844 },
		hasTouch: true,
		isMobile: true,
		deviceScaleFactor: 2
	});

	test('installs as an app, fits the screen, and a long press opens the card menu', async ({
		page
	}) => {
		const manifest = await (await page.request.get('/manifest.webmanifest')).json();
		expect(manifest.display).toBe('standalone');
		expect((await page.request.get(manifest.icons[0].src)).ok()).toBe(true);

		await page.goto('/');
		await ready(page);
		await expect(page.locator('.bottom-nav')).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);

		// Touch has no right-click: holding a card opens its menu, and lifting does not open the card.
		const card = page.locator('.idea-card').first();
		const box = (await card.boundingBox())!;
		const at = { x: box.x + box.width / 2, y: box.y + 20 };
		const cdp = await page.context().newCDPSession(page);
		const touch = (type: string) =>
			cdp.send('Input.dispatchTouchEvent', {
				type,
				touchPoints: type === 'touchEnd' ? [] : [at]
			});
		await touch('touchStart');
		await expect(page.locator('.context-menu')).toBeVisible({ timeout: 2000 });
		await touch('touchEnd');
		await expect(page).toHaveURL('/');
		await page.keyboard.press('Escape');

		// The home-screen shortcut opens a new idea draft.
		await page.goto('/?new=idea');
		await ready(page);
		await expect(page.getByRole('dialog', { name: /A new idea/ })).toBeVisible();
		await expect(page).toHaveURL('/');
	});
});
