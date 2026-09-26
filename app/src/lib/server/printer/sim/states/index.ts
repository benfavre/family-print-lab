// Simulator starting states per model (copied from the conformance fixtures; see ../../__fixtures__/reports).
// Static imports so the simulator runs under tsx as well as in the app.
import BL_P001 from './BL-P001.json';
import C11 from './C11.json';
import C12 from './C12.json';
import N1 from './N1.json';
import N2S from './N2S.json';
import N6 from './N6.json';
import N7 from './N7.json';
import N9 from './N9.json';
import O1C2 from './O1C2.json';
import O1D from './O1D.json';
import O1E from './O1E.json';
import O1S from './O1S.json';
import type { ModelCode } from '$lib/shared/printers/models';

export interface SimState {
	model: string;
	print: Record<string, unknown>;
	get_version: { module: Record<string, unknown>[] } & Record<string, unknown>;
}

const loaded = {
	'BL-P001': BL_P001,
	C11,
	C12,
	N1,
	N2S,
	N6,
	N7,
	N9,
	O1C2,
	O1D,
	O1E,
	O1S
} as unknown as Record<string, SimState>;

/** Models without a state of their own start from their closest sibling. */
const CLOSEST: Partial<Record<ModelCode, string>> = {
	'BL-P002': 'BL-P001',
	C13: 'BL-P001',
	O1C: 'O1C2'
};

export function simState(model: ModelCode): SimState {
	return structuredClone(loaded[model] ?? loaded[CLOSEST[model] ?? 'N6']);
}
