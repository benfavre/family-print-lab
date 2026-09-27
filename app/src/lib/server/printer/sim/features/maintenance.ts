// Maintenance on the simulated printer: system.set_accessories updates the nozzle it reports (the
// fields OpenBambuAPI mqtt.md documents: nozzle_diameter, nozzle_type) on old-format single-nozzle
// printers, and control-page buttons offer or withdraw a firmware update
// (upgrade_state.new_version_state 1 with an "ota" entry in new_ver_list, as Bambu Studio
// DeviceCore/DevUpgrade.cpp reads it) and wear the nozzle (printers that report device.nozzle.info).
import type { Json, SimFeature, SimPrinter } from '../core';

const DIAMETERS = [0.2, 0.4, 0.6, 0.8];
const TYPES = ['stainless_steel', 'hardened_steel'];

/** The extruder nozzle entries on printers that send device.nozzle.info (rack nozzles excluded). */
const extruderNozzles = (sim: SimPrinter): Json[] =>
	(sim.state.device?.nozzle?.info ?? []).filter((n: Json) => ((n.id >> 4) & 0xf) === 0);

export const maintenance: SimFeature = {
	key: 'maintenance',
	command(sim, topic, msg) {
		if (topic !== 'system' || msg.command !== 'set_accessories') return undefined;
		if (msg.accessory_type !== 'nozzle')
			return { result: 'failed', reason: 'unsupported accessory' };
		// Only the printers Bambu Studio sent it to: one nozzle, reported in the old string fields
		// (printers with device.nozzle.info took print.set_nozzle; see accessoryRefusal).
		if (sim.model.nozzles !== 1 || extruderNozzles(sim).length)
			return { result: 'failed', reason: 'not supported' };
		const diameter = Number(msg.nozzle_diameter);
		if (!DIAMETERS.includes(diameter) || !TYPES.includes(msg.nozzle_type))
			return { result: 'failed', reason: 'invalid nozzle' };
		sim.state.nozzle_diameter = String(diameter);
		sim.state.nozzle_type = msg.nozzle_type;
		sim.log(`nozzle set to ${diameter} mm ${msg.nozzle_type.replace('_', ' ')}`);
		return { result: 'success' };
	},
	controls: [
		{
			id: 'offer-update',
			label: 'Offer a firmware update',
			run(sim, body) {
				const version = typeof body?.version === 'string' ? body.version : '99.00.00.00';
				sim.state.upgrade_state = {
					...(sim.state.upgrade_state ?? {}),
					new_version_state: 1,
					new_ver_list: [{ name: 'ota', new_ver: version }]
				};
				sim.log(`firmware ${version} offered`);
			}
		},
		{
			id: 'clear-update',
			label: 'No firmware update',
			run(sim) {
				sim.state.upgrade_state = {
					...(sim.state.upgrade_state ?? {}),
					new_version_state: 2,
					new_ver_list: []
				};
				sim.log('firmware up to date');
			}
		},
		{
			id: 'wear-nozzle',
			label: 'Wear the nozzle',
			run(sim) {
				for (const n of extruderNozzles(sim)) n.wear = Math.round(((n.wear ?? 0) + 0.1) * 10) / 10;
				sim.log('nozzle wear +0.1');
			}
		}
	]
};
