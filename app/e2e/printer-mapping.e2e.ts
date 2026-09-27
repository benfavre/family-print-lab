import { expect, test } from '@playwright/test';
import { fakeSliced } from '../src/lib/server/printer/sliced';
import type { PrinterStatus } from '../src/lib/shared/domain';

// Server safety is covered against MQTT/FTP simulators in manager.test.ts. Here a controlled live
// status feed isolates the SendPanel's reaction to a feeder being rebound while the panel is open.
test('send mapping follows nozzle binding changes and disables unreachable feeders', async ({
	page
}) => {
	await page.addInitScript(() => {
		sessionStorage.setItem('print-lab-profile', 'all');
		class PrinterFeed extends EventTarget {
			constructor() {
				super();
				window.addEventListener('test-printer-status', (event) => {
					this.dispatchEvent(new MessageEvent('printer', { data: (event as CustomEvent).detail }));
				});
			}
			close() {}
		}
		window.EventSource = PrinterFeed as unknown as typeof EventSource;
	});
	const origin = 'http://127.0.0.1:4173';
	const created = await page.request.post('/api/jobs', {
		headers: { origin },
		data: { projectId: 'idea-02', revision: 'Nozzle binding' }
	});
	expect(created.ok()).toBe(true);
	const job = (await created.json()).workspace.jobs.find(
		(j: { revision: string }) => j.revision === 'Nozzle binding'
	);
	const printer: PrinterStatus = (await (await page.request.get('/api/printers')).json())[0];
	expect(printer.state).toBeTruthy();
	const unit = printer.state!.ams[0];
	const tray = unit.trays.find((t) => t.type === 'PLA')!;
	printer.state!.ams = [{ ...unit, nozzle: 0, trays: [tray] }];
	printer.state!.externalSpools = [];
	const attached = await page.request.post(`/api/jobs/${job.id}/sliced?name=left.gcode.3mf`, {
		headers: { origin, 'content-type': 'application/octet-stream' },
		data: fakeSliced({ minutes: 1, grams: 1, printerModelId: 'N6', filamentMaps: [1] })
	});
	expect(attached.ok()).toBe(true);
	const checks: number[][] = [];
	await page.route(`**/api/jobs/${job.id}/send`, (route) => {
		const body = route.request().postDataJSON();
		expect(body.check).toBe(true); // This browser test never starts a print.
		checks.push(body.amsMapping);
		return route.fulfill({ json: { check: { blocking: [], warnings: [] } } });
	});
	await page.goto('/jobs');
	await page.locator('html[data-ready]').waitFor({ state: 'attached' });
	const report = () =>
		page.evaluate((status) => {
			window.dispatchEvent(
				new CustomEvent('test-printer-status', { detail: JSON.stringify(status) })
			);
		}, printer);
	await report();
	await page
		.locator(`.job-card[data-job="${job.id}"]`)
		.getByRole('button', { name: '▣ Send to printer' })
		.click();
	const send = page.getByRole('dialog', { name: /^Print / });
	const select = send.getByLabel('AMS slot for filament 1');
	await expect(select).toHaveValue('-1');
	await expect(select.locator(`option[value="${tray.global}"]`)).toBeDisabled();
	await expect(select.locator(`option[value="${tray.global}"]`)).toContainText('Other nozzle');
	await expect.poll(() => checks.at(-1)).toEqual([-1]);

	// Material, colour and tray number stay exactly the same: only the physical binding changes.
	printer.state!.ams[0].nozzle = 1;
	await report();
	await expect(select).toHaveValue(String(tray.global));
	await expect(select.locator(`option[value="${tray.global}"]`)).toBeEnabled();
	await expect.poll(() => checks.at(-1)).toEqual([tray.global]);
	printer.state!.ams[0].nozzle = 0;
	await report();
	await expect(select).toHaveValue('-1');
	await expect.poll(() => checks.at(-1)).toEqual([-1]);
});
