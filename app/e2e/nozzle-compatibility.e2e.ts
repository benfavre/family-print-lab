import { expect, test } from '@playwright/test';
import { fakeSliced } from '../src/lib/server/printer/sliced';
import { nozzleProblems } from '../src/lib/shared/nozzle-compatibility';
import type { PrinterStatus, SlicedPlate } from '../src/lib/shared/domain';

for (const model of ['C12', 'N6'] as const) {
	test(`${model} send checks nozzle diameter and refreshes when only its diameter changes`, async ({
		page
	}) => {
		await page.addInitScript(() => {
			sessionStorage.setItem('print-lab-profile', 'all');
			class PrinterFeed extends EventTarget {
				constructor() {
					super();
					window.addEventListener('test-nozzle-status', (event) => {
						this.dispatchEvent(
							new MessageEvent('printer', { data: (event as CustomEvent).detail })
						);
					});
				}
				close() {}
			}
			window.EventSource = PrinterFeed as unknown as typeof EventSource;
		});
		const origin = 'http://127.0.0.1:4173';
		const headers = { origin };
		let printers: PrinterStatus[] = await (await page.request.get('/api/printers')).json();
		let added: string | undefined;
		if (!printers.some((p) => p.model === model)) {
			const response = await page.request.post('/api/printers', {
				headers,
				data: {
					name: 'Nozzle test P1S',
					model: 'C12',
					host: '127.0.0.1',
					port: 18841,
					ftpPort: 19001,
					serial: 'SIM-P1S-0001',
					accessCode: '12345678',
					tls: false,
					simulated: true
				}
			});
			expect(response.ok()).toBe(true);
			added = (await response.json()).printer.id;
		}
		try {
			await expect
				.poll(async () => {
					printers = await (await page.request.get('/api/printers')).json();
					return printers.find((p) => p.model === model)?.state?.nozzles.length;
				})
				.toBe(model === 'C12' ? 1 : 2);
			const printer = printers.find((p) => p.model === model)!;
			const revision = `Nozzle diameter ${model}`;
			const created = await page.request.post('/api/jobs', {
				headers,
				data: { projectId: 'idea-02', revision, printerId: printer.id }
			});
			expect(created.ok()).toBe(true);
			const job = (await created.json()).workspace.jobs.find(
				(j: { revision: string }) => j.revision === revision
			);
			const attached = await page.request.post(`/api/jobs/${job.id}/sliced?name=nozzle.gcode.3mf`, {
				headers: { ...headers, 'content-type': 'application/octet-stream' },
				data: fakeSliced({
					minutes: 1,
					grams: 1,
					printerModelId: model,
					filamentMaps: [1],
					nozzleDiameters: model === 'C12' ? [0.6] : [0.6, 0.4]
				})
			});
			expect(attached.ok()).toBe(true);
			const saved = (await attached.json()).workspace.jobs.find(
				(j: { id: string }) => j.id === job.id
			);
			const plate: SlicedPlate = saved.sliced.plates[0];
			const denied = await page.request.post(`/api/jobs/${job.id}/send`, {
				headers,
				data: { printerId: printer.id, useAms: false, amsMapping: [], force: true }
			});
			expect(denied.status()).toBe(409);
			expect((await denied.json()).error).toContain('needs a 0.6 mm');
			await page.goto('/jobs');
			await page.locator('html[data-ready]').waitFor({ state: 'attached' });
			const report = () =>
				page.evaluate((status) => {
					window.dispatchEvent(
						new CustomEvent('test-nozzle-status', { detail: JSON.stringify(status) })
					);
				}, printer);
			await report();
			await page
				.locator(`.job-card[data-job="${job.id}"]`)
				.getByRole('button', { name: '▣ Send to printer' })
				.click();
			const send = page.getByRole('dialog', { name: /^Print / });
			await send.getByLabel('Feed from the AMS').uncheck();
			await expect(send).toContainText(
				model === 'C12' ? 'needs a 0.6 mm nozzle' : 'needs a 0.6 mm left nozzle'
			);
			await expect(send.locator('button.primary')).toBeDisabled();

			// Isolate the reactive browser check: status and check answers reflect a nozzle replacement.
			// Real simulator-backed blocking, force rejection and wake checks also run in server tests.
			await page.route(`**/api/jobs/${job.id}/send`, (route) => {
				expect(route.request().postDataJSON().check).toBe(true);
				return route.fulfill({
					json: {
						check: {
							blocking: nozzleProblems(plate, printer.state!.nozzles, model === 'C12' ? 1 : 2),
							warnings: []
						}
					}
				});
			});
			const nozzle = printer.state!.nozzles.find((n) => n.id === (model === 'C12' ? 0 : 1))!;
			nozzle.diameter = 0.6;
			await report();
			await expect(send).not.toContainText('needs a 0.6 mm');
			await expect(send.getByRole('button', { name: 'Send and start printing' })).toBeEnabled();
			nozzle.diameter = 0.4;
			await report();
			await expect(send).toContainText('needs a 0.6 mm');
			await expect(send.locator('button.primary')).toBeDisabled();
		} finally {
			if (added)
				expect((await page.request.delete(`/api/printers/${added}`, { headers })).ok()).toBe(true);
		}
	});
}
