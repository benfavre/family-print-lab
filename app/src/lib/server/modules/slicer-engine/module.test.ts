import fs from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startTestLab, type TestLab } from '../../testing/harness';
import { integrations, testIntegration } from '../../integrations';
import { writeStl } from '../../cad/mesh';
import { renderScad } from '../../cad/openscad';
import { readSliced } from '../../printer/sliced';
import { fakeInstall, type FakeInstall } from '../../slicer/__fixtures__/install';
import type { SlicerEngine } from '../../slicer/engine';
import { slicerRow } from './module';

const engineInfo = (o: Partial<SlicerEngine['info']> = {}) =>
	({
		info: {
			engine: 'printlab-slicer',
			version: '0.1.0',
			protocol: { major: 1, minor: 0 },
			upstream: {
				name: 'BambuStudio',
				tag: 'v02.08.02.61',
				commit: '926a7192574bcb9b3a732e1ec59a46d79cb45466'
			},
			patchQueue: { version: 1, hash: 'abc', patches: ['0001-Build.patch'] },
			capabilities: ['slice'],
			profiles: { dir: '/x/resources/profiles/BBL', vendorVersion: '02.08.00.05' },
			...o
		}
	}) as SlicerEngine;

describe('the Print Lab Slicer row', () => {
	const where = { printer: 'P1S', enginePath: null, cliPath: null, engineFailed: false };

	it('names the engine, the upstream tag and commit, and the patch queue', () => {
		expect(slicerRow(engineInfo(), { ...where, enginePath: '/opt/printlab-slicer' })).toMatchObject(
			{
				id: 'slicer',
				name: 'Print Lab Slicer',
				available: true,
				version: '0.1.0',
				via: 'Built in, from Bambu Studio v02.08.02.61 (sliced for your P1S)',
				detail:
					'/opt/printlab-slicer · Bambu Studio v02.08.02.61 (926a719257) · patch queue 1, 1 patch(es) · profiles 02.08.00.05'
			}
		);
	});

	it('says when the command line slices instead, and why', () => {
		const cli = engineInfo({
			engine: 'bambu-studio-cli',
			version: '02.08.02.61',
			patchQueue: null
		});
		const row = slicerRow(cli, { ...where, cliPath: '/opt/bambu/AppRun' });
		expect(row).toMatchObject({ available: true, version: '02.08.02.61' });
		expect(row.via).toBe('Bambu Studio command line (fallback), sliced headless for your P1S');
		expect(row.detail).toContain('Print Lab Slicer is not installed');
		expect(slicerRow(cli, { ...where, engineFailed: true }).detail).toContain('did not start');
	});

	it('explains how to get a slicer when there is none', () => {
		const row = slicerRow(null, where);
		expect(row).toMatchObject({ available: false, via: 'Not installed' });
		expect(row.setup.map((s) => s.command)).toContain('BAMBU_STUDIO_PATH=/path/to/AppRun');
	});
});

describe('slicing jobs through the module', () => {
	let install: FakeInstall;
	let t: TestLab;
	beforeAll(() => {
		install = fakeInstall();
	});
	afterAll(() => install.remove());
	afterEach(async () => {
		await t?.stop();
	});

	async function until<T>(get: () => T | undefined, ms = 10_000): Promise<T> {
		const end = Date.now() + ms;
		for (;;) {
			const v = get();
			if (v) return v;
			if (Date.now() > end) throw new Error('Timed out');
			await new Promise((r) => setTimeout(r, 20));
		}
	}

	it('slices a job for the P1S and the simulated P1S prints it to Succeeded', async () => {
		t = await startTestLab({
			fleet: ['N6', 'C12'],
			modules: ['slicer-engine'],
			// The sliced file says 20 minutes; the simulated printer runs them in a second.
			speed: 1200,
			env: { BAMBU_STUDIO_PATH: install.bin }
		});
		const { lab, models, printing, tasks } = t.rt;
		const p1s = t.printer('C12');
		const profileId = lab.createProfile({ name: 'Alex', color: 'blue' });
		const projectId = lab.createProject({ profileId, title: 'Desk hook' });
		const cube = await renderScad('cube([20, 20, 10]);');
		const modelId = models.importFile(projectId, 'Hook', writeStl(cube.soup!), 'stl');
		const versionId = models.detail(modelId).current!.id;
		const jobId = lab.createJob({
			projectId,
			modelVersionId: versionId,
			printerId: p1s.info.id,
			material: 'PLA'
		});

		const task = printing.sliceJob(jobId);
		const done = await until(() =>
			tasks.list().find((x) => x.id === task.id && x.status !== 'running')
		);
		expect(done).toMatchObject({ status: 'done' });
		expect(done.stage).toMatch(/^20 min · 4\.3 g · 0\.20mm Standard @BBL P1S · Bambu PLA Basic/);
		const sliced = lab.getJob(jobId)!.sliced!;
		expect(sliced).toMatchObject({ printerModelId: 'C12', source: 'app' });
		expect(readSliced(fs.readFileSync(printing.file(sliced.file))).plates[0].layers).toBe(100);

		const finished = t.nextEvent('print.finished', (e) => e.printerId === p1s.info.id, 20_000);
		printing.send(jobId, { printerId: p1s.info.id, useAms: false, amsMapping: [] });
		await finished;
		expect(lab.getJob(jobId)).toMatchObject({ status: 'Succeeded', printerId: p1s.info.id });
	}, 30_000);

	// With a real engine build (upstream.sh test sets PRINTLAB_SLICER_PATH): the same job through
	// Print Lab Slicer, printed by the simulated P1S.
	it.runIf(!!process.env.PRINTLAB_SLICER_PATH)(
		'slices a job with Print Lab Slicer and the simulated P1S prints it to Succeeded',
		async ({ skip }) => {
			t = await startTestLab({
				fleet: ['C12'],
				modules: ['slicer-engine'],
				speed: 1200,
				env: { PRINTLAB_SLICER_PATH: process.env.PRINTLAB_SLICER_PATH ?? '' }
			});
			const engine = await t.rt.module('slicer-engine')!.open();
			if (!engine?.has('slice')) skip(); // a protocol-only build cannot slice
			const { lab, models, printing, tasks } = t.rt;
			const p1s = t.printer('C12');
			const profileId = lab.createProfile({ name: 'Alex', color: 'blue' });
			const projectId = lab.createProject({ profileId, title: 'Desk hook' });
			const cube = await renderScad('cube([20, 20, 10]);');
			const modelId = models.importFile(projectId, 'Hook', writeStl(cube.soup!), 'stl');
			const jobId = lab.createJob({
				projectId,
				modelVersionId: models.detail(modelId).current!.id,
				printerId: p1s.info.id,
				material: 'PLA'
			});
			const task = printing.sliceJob(jobId);
			const done = await until(
				() => tasks.list().find((x) => x.id === task.id && x.status !== 'running'),
				120_000
			);
			expect(done).toMatchObject({ status: 'done' });
			const sliced = lab.getJob(jobId)!.sliced!;
			expect(sliced).toMatchObject({ printerModelId: 'C12', source: 'app' });
			const file = readSliced(fs.readFileSync(printing.file(sliced.file)));
			expect(file.plates[0].layers).toBe(50);
			expect(file.thumbnails.get(1)?.length).toBeGreaterThan(0);

			const finished = t.nextEvent('print.finished', (e) => e.printerId === p1s.info.id, 60_000);
			printing.send(jobId, { printerId: p1s.info.id, useAms: false, amsMapping: [] });
			await finished;
			expect(lab.getJob(jobId)).toMatchObject({ status: 'Succeeded', printerId: p1s.info.id });
		},
		200_000
	);

	it('shows the slicer on the Integrations page and slices a test cube there', async () => {
		t = await startTestLab({
			fleet: ['C12'],
			modules: ['slicer-engine'],
			env: { BAMBU_STUDIO_PATH: install.bin }
		});
		const report = await integrations(t.rt, true);
		const row = report.items.find((i) => i.id === 'slicer');
		expect(row).toMatchObject({ kind: 'module', name: 'Print Lab Slicer', available: true });
		expect(report.items.filter((i) => i.id === 'slicer')).toHaveLength(1);
		const test = await testIntegration(t.rt, 'slicer');
		expect(test.ok).toBe(true);
		expect(test.detail).toMatch(
			/^Sliced a test cube for the P1S with the Bambu Studio command line/
		);
	}, 30_000);
});
