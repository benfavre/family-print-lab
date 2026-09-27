// The maintenance package's printer command: tell the printer which nozzle is fitted after a nozzle
// change. Only OpenBambuAPI documents it (mqtt.md "system.set_accessories.nozzle",
// https://github.com/Doridian/OpenBambuAPI): Bambu Studio v02.08.02.61 never sends it (dual-nozzle and
// rack printers read their nozzles themselves, DeviceCore/DevNozzleSystem.cpp), so it is offered only
// on single-nozzle printers and never while printing.
import { z } from 'zod';
import { defineCommand } from '../registry';
import { ACTIVE_PRINTER_STATES } from '$lib/shared/printers/status';
import {
	ACCESSORY_NOZZLE_TYPES,
	NOZZLE_DIAMETERS,
	type AccessoryNozzleType
} from '$lib/shared/maintenance';

export interface SetAccessoriesParams {
	nozzleDiameter: number;
	nozzleType: AccessoryNozzleType;
}

declare module '../registry' {
	interface CommandMap {
		'system.set_accessories': SetAccessoriesParams;
	}
}

export default [
	defineCommand({
		name: 'system.set_accessories',
		topic: 'system',
		source:
			'OpenBambuAPI mqtt.md "system.set_accessories.nozzle" (accessory_type, nozzle_diameter, nozzle_type)',
		params: z.strictObject({
			nozzleDiameter: z
				.number()
				.refine(
					(d) => (NOZZLE_DIAMETERS as readonly number[]).includes(d),
					'Not a Bambu nozzle size.'
				),
			nozzleType: z.enum(ACCESSORY_NOZZLE_TYPES)
		}),
		guard: (ctx) =>
			ctx.model.nozzles !== 1
				? `The ${ctx.model.short} reads its nozzles itself.`
				: ctx.status && ACTIVE_PRINTER_STATES.has(ctx.status.gcodeState)
					? 'Wait until the print is over.'
					: null,
		build: (p) => ({
			command: 'set_accessories',
			accessory_type: 'nozzle',
			nozzle_diameter: p.nozzleDiameter,
			nozzle_type: p.nozzleType
		}),
		settled: (s, p) =>
			s.nozzles[0]?.diameter === p.nozzleDiameter && s.nozzles[0]?.type === p.nozzleType,
		risk: 'confirm'
	})
];
