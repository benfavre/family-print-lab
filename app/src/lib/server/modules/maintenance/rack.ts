// The H2C hotend rack, read from the raw report (the foundation's snapshot keeps only the nozzles on
// the extruders). Follows Bambu Studio v02.08.02.61 DeviceCore/DevNozzleSystem.cpp ParseV2_0: a
// device.nozzle.info[] entry whose id has 1 in its second hex digit (0x10–0x1F) sits on the rack at
// position id & 0xF; device.holder carries the rack's `stat` and `pos` (DevNozzleRack.cpp
// ParseRackInfoV1_0, enums in DevNozzleRack.h).
import type { HotendRack, RackNozzle } from '$lib/shared/maintenance';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any;

/** DevNozzleRack.h RackStatus 0–9. */
const STATUS = [
	'Idle',
	'Moving the hotend to the centre',
	'Moving the toolhead to the centre',
	'Calibrating the rack',
	'Cutting filament',
	'Unlocking a hotend',
	'Lifting the rack',
	'Placing a hotend',
	'Picking a hotend',
	'Locking a hotend'
];
/** DevNozzleRack.h RackPos 1–3 (0 unknown). */
const POSITION = ['', 'A on top', 'B on top', 'Centre'];

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The rack, or null when the report has no rack nozzles and no holder block. */
export function parseRack(print: Raw): HotendRack | null {
	const device = print?.device;
	if (!device || typeof device !== 'object') return null;
	const info: Raw[] = Array.isArray(device.nozzle?.info) ? device.nozzle.info : [];
	const nozzles: RackNozzle[] = info
		.filter((n) => typeof n?.id === 'number' && ((n.id >> 4) & 0xf) === 1)
		.map((n) => ({
			slot: n.id & 0xf,
			diameter: num(n.diameter) && n.diameter > 0 ? n.diameter : null,
			type: typeof n.type === 'string' && n.type ? n.type.slice(0, 20) : null,
			wear: num(n.wear),
			color: colour(n.color_m)
		}))
		.sort((a, b) => a.slot - b.slot);
	const holder = device.holder && typeof device.holder === 'object' ? device.holder : null;
	if (!nozzles.length && !holder) return null;
	const stat = num(holder?.stat);
	const pos = num(holder?.pos);
	return {
		status: stat !== null && stat >= 0 && stat < STATUS.length ? STATUS[stat] : null,
		position: pos !== null && pos > 0 && pos < POSITION.length ? POSITION[pos] : null,
		nozzles
	};
}

/** color_m "RRGGBBAA" → '#rrggbb'; all zeros (nothing loaded) → null. */
function colour(v: unknown): string | null {
	if (typeof v !== 'string' || !/^[0-9a-f]{8}$/i.test(v) || /^0{8}$/.test(v)) return null;
	return `#${v.slice(0, 6).toLowerCase()}`;
}
