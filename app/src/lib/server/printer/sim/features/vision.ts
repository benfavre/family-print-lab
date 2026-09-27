// Pictures of a simulated print for the AI check: while a print runs, the simulated camera shows a part
// growing layer by layer under a moving toolhead (vision-fixtures.ts) instead of the test pattern, and
// the control page can make it go wrong (spaghetti, or the part knocked over) for the rest of that
// print. Between prints the camera shows the test pattern as before.
import type { SimFeature, SimPrinter } from '../core';
import { simFrameSources } from './camera';
import { VISION_DETACHED, VISION_LAYERS, VISION_SPAGHETTI } from './vision-fixtures';

const LAYERS = VISION_LAYERS.map((f) => Buffer.from(f, 'base64'));
const TROUBLE = {
	spaghetti: Buffer.from(VISION_SPAGHETTI, 'base64'),
	detached: Buffer.from(VISION_DETACHED, 'base64')
};
export type SimTrouble = keyof typeof TROUBLE;

/** What went wrong, and in which print (a new print starts clean). */
const trouble = new WeakMap<SimPrinter, { what: SimTrouble; task: string }>();
const task = (sim: SimPrinter) => String(sim.state.subtask_name ?? '');

/** Makes the simulated print go wrong on camera (null: back to normal). */
export function setTrouble(sim: SimPrinter, what: SimTrouble | null) {
	if (what) trouble.set(sim, { what, task: task(sim) });
	else trouble.delete(sim);
	sim.log(
		what
			? `📷 camera shows ${what === 'spaghetti' ? 'spaghetti' : 'a knocked-over part'}`
			: '📷 camera back to normal'
	);
}

const troubleNow = (sim: SimPrinter) => {
	const t = trouble.get(sim);
	return t && t.task === task(sim) ? t.what : null;
};

/** The picture for now: the print's stage, trouble when asked for, null between prints. */
export function scene(sim: SimPrinter): Buffer | null {
	const state = String(sim.state.gcode_state ?? '');
	if (!['PREPARE', 'RUNNING', 'PAUSE'].includes(state)) return null;
	const t = troubleNow(sim);
	if (t) return TROUBLE[t];
	const total = Number(sim.state.total_layer_num) || 0;
	const layer = Number(sim.state.layer_num) || 0;
	const progress = total > 0 ? Math.min(1, Math.max(0, layer / total)) : 0;
	return LAYERS[Math.min(LAYERS.length - 1, Math.floor(progress * LAYERS.length))];
}

export const vision: SimFeature = {
	key: 'vision',
	init(sim) {
		if (sim.model.camera === 'none') return;
		simFrameSources.set(sim, () => scene(sim));
	},
	controls: [
		{
			id: 'vision-spaghetti',
			label: 'Spaghetti on the camera',
			run: (sim) => setTrouble(sim, troubleNow(sim) === 'spaghetti' ? null : 'spaghetti')
		},
		{
			id: 'vision-detached',
			label: 'Knock the part over',
			run: (sim) => setTrouble(sim, troubleNow(sim) === 'detached' ? null : 'detached')
		}
	]
};
