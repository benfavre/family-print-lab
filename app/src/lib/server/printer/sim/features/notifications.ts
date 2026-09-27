// Things worth a notification that the simulator could not do yet: a print pausing because the
// filament ran out (stg_cur 6, "paused_filament_runout" in ha-bambulab pybambu/const.py
// CURRENT_STAGE_IDS, https://github.com/greghesp/ha-bambulab at 0e027ff). Resume carries on.
import type { SimFeature, SimPrinter } from '../core';

export function runOut(sim: SimPrinter) {
	if (sim.state.gcode_state !== 'RUNNING') throw new Error('Only a running print can run out.');
	sim.state.gcode_state = 'PAUSE';
	sim.state.stg_cur = 6;
	sim.log('❚❚ paused: filament ran out (simulated)');
	sim.report();
}

export const notifications: SimFeature = {
	key: 'notifications',
	controls: [{ id: 'runout', label: 'Filament runs out', run: (sim) => runOut(sim) }]
};
