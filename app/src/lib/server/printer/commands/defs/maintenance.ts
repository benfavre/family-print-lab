// The maintenance package's printer command: tell the printer which nozzle is fitted after a nozzle
// change. Payload per OpenBambuAPI mqtt.md "system.set_accessories.nozzle"
// (https://github.com/Doridian/OpenBambuAPI), the same one Bambu Studio v01.10 to v02.00 sent from
// MachineObject::command_set_printer_nozzle (DeviceManager.cpp) for single-nozzle printers on the old
// report format. Printers that report device.nozzle.info got a different command and v02.08 sends
// neither, so it is offered only where accessoryRefusal allows it, never while printing, and only in
// the type and size pairs Bambu Studio offered.
import { z } from 'zod';
import { defineCommand } from '../registry';
import { ACTIVE_PRINTER_STATES } from '$lib/shared/printers/status';
import {
	ACCESSORY_DIAMETERS,
	ACCESSORY_NOZZLE_TYPES,
	NOZZLE_DIAMETERS,
	accessoryRefusal,
	nozzleTypeLabel,
	type AccessoryNozzleType
} from '$lib/shared/maintenance';

/** [0.4, 0.6, 0.8] → "0.4, 0.6 or 0.8". */
const orList = (l: readonly number[]) =>
	l.length > 1 ? `${l.slice(0, -1).join(', ')} or ${l[l.length - 1]}` : String(l[0] ?? '');

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
			'OpenBambuAPI mqtt.md "system.set_accessories.nozzle" (accessory_type, nozzle_diameter, nozzle_type); Bambu Studio v02.00.00.95 DeviceManager.cpp command_set_printer_nozzle',
		params: z.strictObject({
			nozzleDiameter: z
				.number()
				.refine(
					(d) => (NOZZLE_DIAMETERS as readonly number[]).includes(d),
					'Not a Bambu nozzle size.'
				),
			nozzleType: z.enum(ACCESSORY_NOZZLE_TYPES)
		}),
		guard: (ctx, p) =>
			accessoryRefusal(ctx.model, ctx.status?.nozzles[0]?.type) ??
			(ctx.status && ACTIVE_PRINTER_STATES.has(ctx.status.gcodeState)
				? 'Wait until the print is over.'
				: !ACCESSORY_DIAMETERS[p.nozzleType].includes(p.nozzleDiameter)
					? `${nozzleTypeLabel(p.nozzleType)} nozzles come in ${orList(ACCESSORY_DIAMETERS[p.nozzleType])} mm.`
					: null),
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
