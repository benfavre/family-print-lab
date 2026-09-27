// system.set_accessories: the payload OpenBambuAPI mqtt.md documents (and Bambu Studio v02.00.00.95
// command_set_printer_nozzle sent), and the printers, states and sizes it is refused for.
import { describe, expect, it } from 'vitest';
import { commandDef, type CommandContext } from '$lib/server/printer/commands/registry';
import { PRINTER_MODELS, capabilitiesFor, type ModelCode } from '$lib/shared/printers/models';
import { emptySnapshot, type NozzleState } from '$lib/shared/printers/status';
import { parse } from '$lib/server/validation';

const nozzle = (type: string): NozzleState => ({
	id: 0,
	temp: null,
	target: null,
	diameter: 0.4,
	type,
	activeTray: null,
	wear: null
});
const ctx = (model: ModelCode, type: string, state = 'IDLE'): CommandContext => ({
	printerId: 'p',
	model: PRINTER_MODELS[model],
	caps: capabilitiesFor(model, null),
	status: emptySnapshot({ gcodeState: state, nozzles: [nozzle(type)] }),
	firmware: null
});

describe('system.set_accessories', () => {
	const def = commandDef('system.set_accessories')!;

	it('builds the documented payload', () => {
		const params = parse(def.params, { nozzleDiameter: 0.6, nozzleType: 'hardened_steel' });
		expect({
			system: { sequence_id: 'SEQ', ...def.build(params, ctx('C12', 'stainless_steel')) }
		}).toEqual({
			system: {
				sequence_id: 'SEQ',
				command: 'set_accessories',
				accessory_type: 'nozzle',
				nozzle_diameter: 0.6,
				nozzle_type: 'hardened_steel'
			}
		});
		expect(def.risk).toBe('confirm');
		expect(() =>
			parse(def.params, { nozzleDiameter: 0.5, nozzleType: 'hardened_steel' })
		).toThrow();
		expect(() => parse(def.params, { nozzleDiameter: 0.4, nozzleType: 'brass' })).toThrow();
	});

	it('is refused where Bambu Studio did not send it', () => {
		const p = { nozzleDiameter: 0.4, nozzleType: 'stainless_steel' as const };
		expect(def.guard!(ctx('C12', 'stainless_steel'), p)).toBeNull();
		expect(def.guard!(ctx('N1', 'hardened_steel'), p)).toBeNull();
		// A P2S reports device.nozzle.info codes; an H2D has two nozzles.
		expect(def.guard!(ctx('N7', 'HS01'), p)).toMatch(/reads its nozzles itself/);
		expect(def.guard!(ctx('O1D', 'stainless_steel'), p)).toMatch(/reads its nozzles itself/);
		expect(def.guard!(ctx('C12', 'stainless_steel', 'RUNNING'), p)).toMatch(/print is over/);
	});

	it('only sends the type and size pairs Bambu Studio offered', () => {
		const c = ctx('C12', 'stainless_steel');
		expect(def.guard!(c, { nozzleDiameter: 0.8, nozzleType: 'stainless_steel' })).toBe(
			'Stainless steel nozzles come in 0.2 or 0.4 mm.'
		);
		expect(def.guard!(c, { nozzleDiameter: 0.2, nozzleType: 'hardened_steel' })).toBe(
			'Hardened steel nozzles come in 0.4, 0.6 or 0.8 mm.'
		);
		expect(def.guard!(c, { nozzleDiameter: 0.2, nozzleType: 'stainless_steel' })).toBeNull();
		expect(def.guard!(c, { nozzleDiameter: 0.8, nozzleType: 'hardened_steel' })).toBeNull();
	});
});
