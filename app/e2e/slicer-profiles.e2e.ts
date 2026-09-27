import { expect, test, type Page } from '@playwright/test';

// Settings → Slicer profiles against the small fixture vendor folder (PRINTLAB_PROFILES_DIR in
// playwright.config.ts): browse Bambu Studio's presets, save one as your own with a change, see only
// the change stored, and find it in the combined config a slice would use.
const ready = (page: Page) => page.locator('html[data-ready]').waitFor({ state: 'attached' });

test.beforeEach(async ({ context }) => {
	await context.addInitScript(() => sessionStorage.setItem('print-lab-profile', 'all'));
});

test('Slicer profiles: browse, save a system preset as your own with a change, and use it', async ({
	page
}) => {
	await page.goto('/integrations');
	await ready(page);
	const section = page.locator('#slicer-profiles');
	await expect(section.getByRole('heading', { name: 'Slicer profiles' })).toBeVisible();

	// The fixture covers the X1C and the A1 mini; the simulated X2D has no presets there.
	await section.getByLabel('Printer model').selectOption({ label: 'X1C' });
	await section.getByRole('tab', { name: 'Process' }).click();
	await section.getByRole('button', { name: /0\.20mm Standard @BBL X1C/ }).click();

	const editor = section.getByLabel('Preset editor');
	await expect(editor).toContainText('BAMBU STUDIO');
	await editor.getByLabel('Find a setting').fill('sparse_infill');
	await editor.getByLabel('sparse_infill_density', { exact: true }).fill('45%');
	await editor.getByLabel('sparse_infill_density', { exact: true }).blur();
	await editor.getByLabel('Name for your copy').fill('Strong X1C');
	await editor.getByRole('button', { name: 'Save as my preset' }).click();
	await expect(editor).toContainText('YOURS');
	await expect(editor.getByLabel('Preset name')).toHaveValue('Strong X1C');

	// Only the change is stored, against the system preset it is based on.
	const mine = section.getByLabel('Your presets');
	await expect(mine).toContainText('Strong X1C');
	await expect(mine).toContainText('1 change');
	const users = await (await page.request.get('/api/slicer/presets')).json();
	const strong = users.find((u: { name: string }) => u.name === 'Strong X1C');
	expect(strong).toMatchObject({
		kind: 'process',
		inherits: '0.20mm Standard @BBL X1C',
		config: { sparse_infill_density: '45%' }
	});

	// It flows into the flat config a slice uses.
	const bundle = await page.request.post('/api/slicer/profiles/bundle', {
		data: {
			selection: {
				printer: { kind: 'printer', name: 'Bambu Lab X1 Carbon 0.4 nozzle', source: 'system' },
				process: { kind: 'process', name: 'Strong X1C', source: 'user', userPresetId: strong.id },
				filaments: [{ kind: 'filament', name: 'Bambu PLA Basic @BBL X1C', source: 'system' }]
			}
		}
	});
	const full = (await bundle.json()).full;
	expect(full.sparse_infill_density).toBe('45%');
	expect(full.different_settings_to_system).toEqual(['sparse_infill_density', '', '']);

	// Exported as Bambu Studio's user preset .json.
	const exported = await page.request.get(`/api/slicer/presets/${strong.id}/export`);
	expect(await exported.json()).toMatchObject({
		name: 'Strong X1C',
		from: 'User',
		inherits: '0.20mm Standard @BBL X1C',
		print_settings_id: 'Strong X1C',
		sparse_infill_density: '45%'
	});

	// Deleting asks first.
	await editor.getByRole('button', { name: 'Delete' }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
	await expect(mine).toHaveCount(0);
});
