// Reading a calibration test's parameter steps back out of its G-code, for the golden tests: the lines
// upstream's GCode.cpp and GCodeWriter.cpp write at each layer change (M900 "Override pressure advance
// value", M104 "set nozzle temperature", the "Calib_Retraction_tower" comment, the outer wall feed
// rate) and the extrusion per millimetre of each object (the flow rate test's print_flow_ratio).

/** Numbers after `re`'s first group, in order. */
function numbers(gcode: string, re: RegExp): number[] {
	return [...gcode.matchAll(re)].map((m) => parseFloat(m[1]));
}

/** Pressure advance values the test sets (GCodeWriter::set_pressure_advance), in order. */
export function paOverrides(gcode: string): number[] {
	return numbers(gcode, /^\s*M90[01](?: P[\d.]+)? K([\d.e-]+); Override pressure advance value$/gm);
}

/** Nozzle temperatures set at layer changes (GCodeWriter::set_temperature), repeats folded. */
export function layerTemperatures(gcode: string): number[] {
	const all = numbers(gcode, /^M104 S(\d+) ; set nozzle temperature$/gm);
	return all.filter((t, i) => i === 0 || t !== all[i - 1]);
}

/** Retraction lengths the retraction tower sets per layer (GCode.cpp's comment). */
export function retractionLengths(gcode: string): number[] {
	return numbers(gcode, /^; Calib_Retraction_tower: Z_HEIGHT: [\d.]+, length:([\d.e-]+)$/gm);
}

/** The fastest extrusion feed rate (mm/s) on each whole millimetre of height (towers in vase mode). */
export function speedsByHeight(gcode: string): Map<number, number> {
	const out = new Map<number, number>();
	let z = 0;
	for (const line of gcode.split('\n')) {
		if (line.startsWith('; Z_HEIGHT:')) z = parseFloat(line.slice(11));
		else if (/^G1 F[\d.]+$/.test(line)) {
			const band = Math.floor(z + 1e-6);
			const speed = parseFloat(line.slice(4)) / 60;
			if (speed > (out.get(band) ?? 0)) out.set(band, speed);
		}
	}
	return out;
}

/**
 * Extrusion per millimetre of travel on one feature (e.g. "Outer wall") for each object, from layer
 * `fromZ` up: objects of the same shape differ only by their flow ratio.
 */
export function flowByObject(gcode: string, feature: string, fromZ = 0.5): Map<string, number> {
	const e = new Map<string, number>();
	const d = new Map<string, number>();
	let z = 0,
		x = 0,
		y = 0,
		object = '',
		current = '';
	const arg = (line: string, axis: string) => {
		const m = line.match(new RegExp(` ${axis}(-?[\\d.]+)`));
		return m ? parseFloat(m[1]) : null;
	};
	for (const line of gcode.split('\n')) {
		if (line.startsWith('; Z_HEIGHT:')) z = parseFloat(line.slice(11));
		else if (line.startsWith('; OBJECT_ID:')) object = line.slice(12).trim();
		else if (line.startsWith('; FEATURE:')) current = line.slice(10).trim();
		else if (/^G[01] /.test(line)) {
			const nx = arg(line, 'X') ?? x;
			const ny = arg(line, 'Y') ?? y;
			const de = arg(line, 'E') ?? 0;
			const dist = Math.hypot(nx - x, ny - y);
			if (z > fromZ && current === feature && de > 0 && dist > 1 && object) {
				e.set(object, (e.get(object) ?? 0) + de);
				d.set(object, (d.get(object) ?? 0) + dist);
			}
			x = nx;
			y = ny;
		}
	}
	return new Map([...e].map(([k, v]) => [k, v / d.get(k)!]));
}
