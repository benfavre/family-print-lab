import { afterEach, describe, expect, it } from 'vitest';
import { startTestLab, type TestLab } from '../testing/harness';
import { fakeSliced } from './sliced';
import type { ModelCode } from '$lib/shared/printers/models';

const labs: TestLab[] = [];
afterEach(async () => {
	for (const lab of labs.splice(0)) await lab.stop();
});
async function setup(model: ModelCode, diameters: number[], filamentMaps = [1]) {
	const t = await startTestLab({ modules: [], fleet: [model] });
	labs.push(t);
	const profileId = t.rt.lab.createProfile({ name: 'Alex', color: 'blue' });
	const projectId = t.rt.lab.createProject({ profileId, title: 'Nozzle check' });
	const jobId = t.rt.lab.createJob({ projectId });
	t.rt.printing.attach(
		jobId,
		fakeSliced({
			minutes: 1,
			grams: 1,
			printerModelId: model,
			nozzleDiameters: diameters,
			filamentMaps
		}),
		'nozzle.gcode.3mf'
	);
	return { t, jobId, p: t.printer(model) };
}
async function until(check: () => boolean) {
	const end = Date.now() + 5000;
	while (!check()) {
		if (Date.now() > end) throw new Error('No matching printer report');
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe('nozzle compatibility before uploading', () => {
	it.each(['C12', 'N6'] as const)(
		'blocks a mismatched %s nozzle even with force and without AMS',
		async (model) => {
			const { t, jobId, p } = await setup(model, model === 'C12' ? [0.6] : [0.6, 0.4]);
			const filesBefore = [...p.sim.files.keys()];
			const options = { printerId: p.info.id, useAms: false, amsMapping: [], force: true };
			expect(t.rt.lab.getJob(jobId)?.sliced?.plates[0].nozzleDiameters).toEqual(
				model === 'C12' ? [0.6] : [0.6, 0.4]
			);
			expect(t.rt.printing.check(jobId, options).blocking[0]).toContain('needs a 0.6 mm');
			expect(() => t.rt.printing.send(jobId, options)).toThrow(/needs a 0.6 mm/);
			expect([...p.sim.files.keys()]).toEqual(filesBefore);
			expect(t.rt.lab.getJob(jobId)?.status).toBe('Queued');
		}
	);
	it('allows a dual plate that uses only the compatible right nozzle', async () => {
		const { t, jobId, p } = await setup('N6', [0.6, 0.4], [2]);
		expect(
			t.rt.printing.check(jobId, { printerId: p.info.id, useAms: false, amsMapping: [] })
		).toEqual({ blocking: [], warnings: [] });
	});
	it('checks the newly reported diameter after wake, before uploading, even with force', async () => {
		const { t, jobId, p } = await setup('C12', [0.4]);
		const filesBefore = [...p.sim.files.keys()];
		const off = t.rt.hooks.beforeDispatch.add(async () => {
			p.sim.state.nozzle_diameter = '0.6';
			p.sim.report();
			await until(() => t.rt.printers.require(p.info.id).snapshot?.nozzles[0].diameter === 0.6);
		});
		try {
			const task = t.rt.printing.send(jobId, {
				printerId: p.info.id,
				useAms: false,
				amsMapping: [],
				wake: true,
				force: true
			});
			await until(() => t.rt.tasks.get(task.id).status !== 'running');
			expect(t.rt.tasks.get(task.id)).toMatchObject({
				status: 'failed',
				error: expect.stringContaining('reports 0.6 mm')
			});
			expect([...p.sim.files.keys()]).toEqual(filesBefore);
			expect(t.rt.lab.getJob(jobId)?.status).toBe('Queued');
		} finally {
			off();
		}
	});
});
