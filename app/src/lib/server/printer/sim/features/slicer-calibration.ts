// The printer's own calibration on the simulated printer (slicer-calibration): flow dynamics (PA)
// K-value profiles kept per printer and answered in the reply shapes Bambu Studio reads
// (DeviceCore/DevCalib.cpp: from_json(PACalibResult) with k_value and n_coef as text, cali_idx,
// filament_id, setting_id, nozzle_id; FlowrateGetResultParse's flow_ratio as text), and calibration
// runs that finish at once with canned results. Only printers that report the feature bits answer
// (flags.ts bits 6 and 7), as the real ones do.
import type { Json, SimFeature, SimPrinter } from '../core';

interface CalibState {
	profiles: Json[];
	paResults: Json[];
	flowResults: Json[];
}

const states = new WeakMap<SimPrinter, CalibState>();
const f6 = (n: number) => n.toFixed(6);

/** Bit `n` of the printer's `fun` hex, or undefined without one. */
function funBit(sim: SimPrinter, n: number): boolean | undefined {
	const fun = sim.state.fun;
	if (typeof fun !== 'string' || !/^[0-9a-f]+$/i.test(fun)) return undefined;
	return ((BigInt(`0x${fun}`) >> BigInt(n)) & 1n) === 1n;
}

function stateOf(sim: SimPrinter): CalibState {
	let s = states.get(sim);
	if (!s) {
		// One saved profile, as a printer that has calibrated Bambu PLA Basic once would have.
		s = {
			profiles: [
				{
					cali_idx: 1,
					filament_id: 'GFA00',
					setting_id: 'GFSA00',
					name: 'Bambu PLA Basic',
					k_value: f6(0.02),
					n_coef: f6(0),
					extruder_id: 0,
					nozzle_id: 'HS00-0.4',
					nozzle_diameter: '0.4'
				}
			],
			paResults: [],
			flowResults: []
		};
		states.set(sim, s);
	}
	return s;
}

export const slicerCalibration: SimFeature = {
	key: 'slicer-calibration',
	command(sim, topic, msg) {
		if (topic !== 'print' || typeof msg.command !== 'string') return undefined;
		const pa = /^extrusion_cali/.test(msg.command);
		const flow = /^flowrate_/.test(msg.command);
		if (!pa && !flow) return undefined;
		if (funBit(sim, pa ? 7 : 6) === false) return { result: 'failed', reason: 'not supported' };
		const s = stateOf(sim);
		const filaments: Json[] = Array.isArray(msg.filaments) ? msg.filaments : [];
		switch (msg.command) {
			case 'extrusion_cali':
				// A real printer prints its calibration lines first; the simulator has the answer at once.
				s.paResults = filaments.map((f: Json, i: number) => ({
					tray_id: f.tray_id,
					ams_id: f.ams_id,
					slot_id: f.slot_id,
					extruder_id: f.extruder_id ?? 0,
					filament_id: f.filament_id,
					setting_id: f.setting_id,
					nozzle_id: f.nozzle_id,
					nozzle_diameter: msg.nozzle_diameter,
					k_value: f6(0.024 + 0.002 * i),
					n_coef: f6(0),
					confidence: 0
				}));
				sim.log(`flow dynamics calibration for ${filaments.length} tray(s)`);
				return { result: 'success' };
			case 'extrusion_cali_get_result':
				return {
					result: 'success',
					extra: { nozzle_diameter: msg.nozzle_diameter, filaments: s.paResults }
				};
			case 'extrusion_cali_get':
				return {
					result: 'success',
					extra: {
						nozzle_diameter: msg.nozzle_diameter,
						filament_id: msg.filament_id ?? '',
						filaments: s.profiles.filter(
							(p) =>
								(!msg.filament_id || p.filament_id === msg.filament_id) &&
								p.nozzle_diameter === msg.nozzle_diameter
						)
					}
				};
			case 'extrusion_cali_set':
				for (const f of filaments) {
					const existing = s.profiles.find(
						(p) => p.cali_idx === f.cali_idx && p.filament_id === f.filament_id
					);
					const entry = {
						cali_idx:
							existing?.cali_idx ?? Math.max(0, ...s.profiles.map((p) => Number(p.cali_idx))) + 1,
						filament_id: f.filament_id,
						setting_id: f.setting_id,
						name: f.name,
						k_value: f.k_value,
						n_coef: f.n_coef,
						extruder_id: f.extruder_id ?? 0,
						nozzle_id: f.nozzle_id,
						nozzle_diameter: f.nozzle_diameter ?? msg.nozzle_diameter
					};
					if (existing) Object.assign(existing, entry);
					else s.profiles.push(entry);
				}
				sim.log(`saved ${filaments.length} K profile(s)`);
				return { result: 'success' };
			case 'extrusion_cali_sel': {
				// The tray remembers its profile (cali_idx in the AMS report, DevFilaSystem.cpp).
				for (const unit of sim.state.ams?.ams ?? [])
					for (const tray of unit.tray ?? [])
						if (Number(unit.id) === msg.ams_id && Number(tray.id) === msg.slot_id)
							tray.cali_idx = msg.cali_idx;
				sim.log(`tray ${msg.tray_id} uses K profile ${msg.cali_idx}`);
				return { result: 'success', extra: { tray_id: msg.tray_id, cali_idx: msg.cali_idx } };
			}
			case 'extrusion_cali_del': {
				const before = s.profiles.length;
				s.profiles = s.profiles.filter(
					(p) => !(p.cali_idx === msg.cali_idx && p.filament_id === msg.filament_id)
				);
				return before === s.profiles.length
					? { result: 'failed', reason: 'no such profile' }
					: { result: 'success' };
			}
			case 'flowrate_cali':
				s.flowResults = filaments.map((f: Json) => ({
					tray_id: f.tray_id,
					nozzle_diameter: msg.nozzle_diameter,
					filament_id: f.filament_id,
					setting_id: f.setting_id,
					flow_ratio: f6(Math.round(parseFloat(f.def_flow_ratio ?? '0.98') * 0.97 * 1000) / 1000),
					confidence: 0
				}));
				sim.log(`flow rate calibration for ${filaments.length} tray(s)`);
				return { result: 'success' };
			case 'flowrate_get_result':
				return { result: 'success', extra: { filaments: s.flowResults } };
			default:
				return undefined;
		}
	}
};
