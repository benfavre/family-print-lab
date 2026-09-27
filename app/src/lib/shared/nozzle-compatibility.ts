import type { SlicedPlate } from './domain';
import type { NozzleState } from './printers/status';

export type NozzleReport = Pick<NozzleState, 'id' | 'diameter'>;
export type NozzleRequirements = Pick<
	SlicedPlate,
	'filaments' | 'nozzleDiameters' | 'dynamicNozzleMapping'
>;

/**
 * Bambu Studio v02.08.02.61 PartPlate.cpp get_physical_extruder_by_logical_extruder:
 * single logical 0 -> physical 0; dual logical 0/left -> physical 1, logical 1/right -> physical 0.
 * SelectMachine.cpp collect_used_extuder_nozzles checks only used filaments, with filament_map - 1
 * indexing nozzle_diameter. Unknown legacy values and dynamic rack/switcher assignments cannot
 * establish a fixed-side mismatch, so preserve their previous behaviour rather than guess.
 */
export function nozzleProblems(
	plate: NozzleRequirements,
	reported: readonly NozzleReport[] | null | undefined,
	nozzleCount: number
): string[] {
	const required = plate.nozzleDiameters;
	if (plate.dynamicNozzleMapping || !required || required.length !== nozzleCount) return [];
	const used =
		nozzleCount === 1
			? [0]
			: nozzleCount === 2
				? [...new Set(plate.filaments.flatMap((f) => (f.extruder ? [f.extruder - 1] : [])))]
				: [];
	const valid = (n: number | null | undefined): n is number =>
		typeof n === 'number' && Number.isFinite(n) && n > 0;
	return used.flatMap((logical) => {
		const diameter = required[logical];
		const physical = nozzleCount === 1 ? 0 : 1 - logical;
		const installed = reported?.find((n) => n.id === physical)?.diameter;
		if (!valid(diameter) || !valid(installed) || Math.abs(diameter - installed) < 0.000001)
			return [];
		const name = nozzleCount === 1 ? 'nozzle' : logical === 0 ? 'left nozzle' : 'right nozzle';
		return [
			`This plate needs a ${diameter} mm ${name}, but this printer reports ${installed} mm. Re-slice for this nozzle or fit the matching nozzle.`
		];
	});
}
