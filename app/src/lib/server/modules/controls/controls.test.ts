// Printer controls against the simulated X2D (Bambu Studio's MQTT commands), P1S and A1 mini (G-code
// fallbacks): each control either shows up in the next report or is refused with the right reason.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestLab, type TestLab } from '../../testing/harness';
import type { CommandName } from '../../printer/commands/registry';
import type { ModelCode } from '$lib/shared/printers/models';
import type { PrinterSnapshot } from '$lib/shared/printers/status';
import { slicedWithObjects } from './fixtures';

let t: TestLab;
beforeAll(async () => {
	t = await startTestLab({ fleet: ['N6', 'C12', 'N1'], modules: ['controls'] });
});
afterAll(() => t?.stop());

async function until(check: () => unknown, ms = 8000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error('Timed out waiting for condition');
}

const printer = (model: ModelCode) => t.rt.printers.require(t.printer(model).info.id);
const send = (model: ModelCode, name: string, params: Record<string, unknown> = {}) =>
	printer(model).send(name as CommandName, params);
const state = (model: ModelCode) => printer(model).snapshot as PrinterSnapshot;

describe('printer controls on the simulated fleet', () => {
	it('sets temperatures with set_* on the X2D and M104/M140 on the P1S', async () => {
		expect((await send('N6', 'print.set_bed_temp', { temp: 70 })).outcome).toBe('confirmed');
		await until(() => state('N6').bedTarget === 70);
		await send('N6', 'print.set_nozzle_temp', { temp: 180, nozzle: 1 });
		await until(() => state('N6').nozzles.find((n) => n.id === 1)?.target === 180);
		await send('N6', 'print.set_ctt', { temp: 45 });
		await until(() => state('N6').chamberTarget === 45);

		await send('C12', 'print.set_bed_temp', { temp: 60 });
		await until(() => state('C12').bedTarget === 60);
		await send('C12', 'print.set_nozzle_temp', { temp: 190 });
		await until(() => state('C12').nozzleTarget === 190);
		await expect(send('C12', 'print.set_ctt', { temp: 40 })).rejects.toThrow(/cannot do that/);
		await expect(send('N1', 'print.set_bed_temp', { temp: 90 })).rejects.toThrow(/80 °C/);
		for (const m of ['N6', 'C12'] as const) await send(m, 'print.set_bed_temp', { temp: 0 });
	});

	it('switches lights and fans, or says the printer has none', async () => {
		await send('N6', 'system.ledctrl', { node: 'work_light', mode: 'on' });
		await until(() => state('N6').lights.work === 'on');
		await send('C12', 'system.ledctrl', { node: 'chamber_light', mode: 'off' });
		await until(() => state('C12').lights.chamber === 'off');
		await expect(send('N1', 'system.ledctrl', { node: 'work_light', mode: 'on' })).rejects.toThrow(
			/no work light/
		);

		await send('N6', 'print.set_fan', { fan: 'part', percent: 50 });
		await until(() => state('N6').fans.part === 50);
		await send('N6', 'print.set_fan', { fan: 'secondaryAux', percent: 30 });
		await until(() => state('N6').fans.secondaryAux === 30);
		await send('C12', 'print.set_fan', { fan: 'aux', percent: 70 });
		await until(() => state('C12').fans.aux === 70);
		await expect(send('N1', 'print.set_fan', { fan: 'chamber', percent: 50 })).rejects.toThrow(
			/no chamber fan/
		);
		await send('N6', 'print.set_airduct', { mode: 1 });
		await until(() => state('N6').airductMode === 1);
	});

	it('switches the X2D nozzle and loads and unloads filament', async () => {
		await send('N6', 'print.select_extruder', { nozzle: 1 });
		await until(() => state('N6').activeNozzle === 1);
		await send('N6', 'print.select_extruder', { nozzle: 0 });
		await until(() => state('N6').activeNozzle === 0);

		expect((await send('N6', 'print.ams_change_filament', { tray: 1 })).outcome).toBe('confirmed');
		await until(() => state('N6').activeTray === 1);
		await send('N6', 'print.ams_change_filament:unload');
		await until(() => state('N6').activeTray === null);
		await expect(send('N6', 'print.ams_change_filament:unload')).rejects.toThrow(/No filament/);
	});

	it('homes and plays a calibration while idle', { timeout: 20_000 }, async () => {
		expect((await send('C12', 'print.back_to_center')).outcome).toBe('confirmed');
		expect((await send('N6', 'print.back_to_center')).outcome).toBe('confirmed');
		expect((await send('N6', 'print.xyz_ctrl', { axis: 'X', distance: 10 })).outcome).toBe(
			'confirmed'
		);
		await send('N6', 'print.calibration', { bedLeveling: true, vibration: true });
		await until(() => state('N6').stage.id === 1);
		await until(() => state('N6').stage.id === 3, 10_000);
		expect(state('N6').stage.name).toBe('Vibration compensation');
	});

	it(
		'changes speed, skips objects and reads them from the job file while printing',
		{
			timeout: 20_000
		},
		async () => {
			const p1s = t.printer('C12');
			const { lab, printing } = t.rt;
			const profileId = lab.createProfile({ name: 'Alex', color: 'blue' });
			const projectId = lab.createProject({ profileId, title: 'Rockets' });
			const jobId = lab.createJob({ projectId });
			printing.attach(
				jobId,
				slicedWithObjects(
					[
						{ id: 139, name: 'rocket', bbox: [20, 30, 60, 80] },
						{ id: 522, name: 'stand' }
					],
					{ model: 'C12', picture: Buffer.from('png') }
				),
				'rockets.gcode.3mf'
			);
			await expect(send('C12', 'print.print_speed', { level: 3 })).rejects.toThrow(
				/while printing/
			);
			const started = t.nextEvent('print.started', (e) => e.printerId === p1s.info.id);
			printing.send(jobId, { printerId: p1s.info.id, useAms: true, amsMapping: [0] });
			await started;
			await until(() => state('C12').gcodeState === 'RUNNING');

			await send('C12', 'print.print_speed', { level: 3 });
			await until(() => state('C12').speed.level === 3);

			const controls = t.rt.module('controls')!;
			expect(controls.objects(p1s.info.id)).toMatchObject({
				source: 'file',
				plate: 1,
				picture: true,
				objects: [
					{ id: 139, name: 'rocket', skipped: false, bbox: [20, 30, 60, 80] },
					{ id: 522, name: 'stand', skipped: false }
				]
			});
			expect(controls.platePicture(p1s.info.id)?.toString()).toBe('png');
			const before = state('C12').remainingMinutes ?? 0;
			expect((await send('C12', 'print.skip_objects', { ids: [522] })).outcome).toBe('confirmed');
			await until(() => state('C12').skippedObjects.includes(522));
			expect(controls.objects(p1s.info.id).objects[1].skipped).toBe(true);
			await until(() => (state('C12').remainingMinutes ?? 0) < before);
			await send('C12', 'print.stop');
			await until(() => state('C12').gcodeState === 'FAILED');
			expect(controls.objects(p1s.info.id)).toMatchObject({ source: 'report', objects: [] });
		}
	);

	it('reports print options and turns them on and off', async () => {
		const controls = t.rt.module('controls')!;
		const id = t.printer('N1').info.id;
		await send('N1', 'print.print_option', { option: 'sound', enabled: false });
		await until(() => controls.options(id).sound.enabled === false);
		await send('N1', 'print.print_option', { option: 'sound', enabled: true });
		await until(() => controls.options(id).sound.enabled === true);
		expect(controls.options(id).sound.supported).toBe(true);
		// The X2D reports options in cfg as well (Bambu Studio ParseDetectionV2_0).
		const x2d = t.printer('N6').info.id;
		const was = controls.options(x2d).autoRecovery.enabled;
		await send('N6', 'print.print_option', { option: 'autoRecovery', enabled: !was });
		await until(() => controls.options(x2d).autoRecovery.enabled === !was);
		await send('N6', 'xcam.xcam_control_set', {
			detector: 'first_layer_inspector',
			enabled: false
		});
		await until(() => state('N6').xcam.firstLayer === false);
	});

	it('guards custom G-code while printing and runs it when idle', async () => {
		await send('N1', 'print.gcode_line:custom', { lines: ['M140 S40'] });
		await until(() => state('N1').bedTarget === 40);
		await send('N1', 'print.set_bed_temp', { temp: 0 });
		t.printer('N1').sim.print.start({ minutes: 30 });
		await until(() => ['PREPARE', 'RUNNING'].includes(state('N1').gcodeState));
		await expect(send('N1', 'print.gcode_line:custom', { lines: ['G28'] })).rejects.toThrow(
			/blocked while printing/
		);
		await expect(send('N1', 'print.back_to_center')).rejects.toThrow(/Wait until/);
		t.printer('N1').sim.print.stop();
	});
});
