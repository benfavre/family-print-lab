// The print commands every simulated printer obeys, answered the way the firmware does: start an
// uploaded sliced file (project_file), pause, resume, stop, and G-code lines (logged, not executed).
import type { SimFeature } from '../core';

export const core: SimFeature = {
	key: 'core',
	command(sim, topic, msg) {
		if (topic !== 'print') return undefined;
		switch (msg.command) {
			case 'project_file':
				sim.print.startFile(msg);
				return { result: 'success' };
			case 'pause':
				sim.print.pause();
				return { result: 'success' };
			case 'resume':
				sim.print.resume();
				return { result: 'success' };
			case 'stop':
				sim.print.stop();
				return { result: 'success' };
			case 'gcode_line':
				sim.log(
					`G-code: ${String(msg.param ?? '')
						.trim()
						.replace(/\n/g, ' · ')
						.slice(0, 200)}`
				);
				return { result: 'success' };
			default:
				return undefined;
		}
	}
};
