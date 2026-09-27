// G-code → toolpath preview (the 4.7.3 container). The parser streams: feed it chunks of the plate's
// G-code as they are inflated and it keeps only the segments, never the text. It follows what Bambu
// Studio's own previewer does (src/libslic3r/GCode/GCodeProcessor.cpp at v02.08.02.61):
//
// - G0 and G1 are the same move; its type comes from the E delta (process_G1 move_type): pushing
//   filament while moving in X/Y extrudes, anything else that moves is a travel, and moves between
//   "; WIPE_START" and "; WIPE_END" are wipes.
// - G2/G3 arcs use I/J centres (process_G2_G3), are cut into straight pieces with the same 0.0125 mm
//   tolerance (DRAW_ARC_TOLERANCE), and "P1" with the same start and end is a full circle.
// - G90/G91 switch X/Y/Z (and E) between absolute and relative; M82/M83 switch E alone; G92 sets the
//   current position.
// - "; FEATURE: <role>" names the role (ExtrusionEntity::string_to_role), "; CHANGE_LAYER" starts a
//   layer with "; Z_HEIGHT:" and "; LAYER_HEIGHT:" after it (GCode.cpp ~4622), "; LINE_WIDTH:" sets
//   the width, "; FLUSH_START"/"; FLUSH_END" wrap purges, T<n> (0–254; T255, T1000 and T1100 are
//   Bambu's special commands, process_T) and M1020 S<n> change filament.
// - M73 P<percent> R<minutes> is written each time the whole percent or minute changes
//   (GCodeProcessor.cpp ~826, masks at ~1666); each new percent is an exact point in time, so layer
//   times come from the feed-rate estimate pinned to those points.
//
// PrusaSlicer/OrcaSlicer spellings (";LAYER_CHANGE", ";Z:", ";HEIGHT:", ";TYPE:", ";WIDTH:") are read
// too, so files from other slicers still preview.
//
// Both functions below also run inside a worker thread, where worker.ts loads them from their source
// text: they must not use imports or anything outside their own body (types are fine; they vanish).
import type { PreviewData, PreviewHeader } from '$lib/shared/slicer/preview';

export interface GcodeFilament {
	/** 0-based filament index, as T<n> uses it. */
	index: number;
	color: string;
	type: string;
}

export interface ParseOptions {
	plate: number;
	/** PREVIEW_FEATURES (passed in: the worker cannot import it). */
	features: readonly string[];
	/** The plate's filaments from slice_info (else the G-code's own config block is used). */
	filaments?: GcodeFilament[];
	/** Segment count above which the preview is thinned (default 5 000 000). */
	budget?: number;
}

export interface GcodeParser {
	push(chunk: Uint8Array): void;
	finish(): PreviewData;
}

export function createGcodeParser(opts: ParseOptions): GcodeParser {
	const features = opts.features;
	const budget = opts.budget ?? 5_000_000;
	const code = (name: string) => Math.max(0, features.indexOf(name));
	const TRAVEL = code('Travel'),
		WIPE = code('Wipe'),
		CUSTOM = code('Custom'),
		FLUSH = code('Flush');
	// Other slicers' role names → Bambu's.
	const ALIAS: Record<string, string> = {
		Undefined: 'Other',
		Perimeter: 'Inner wall',
		'External perimeter': 'Outer wall',
		'Overhang perimeter': 'Overhang wall',
		'Internal infill': 'Sparse infill',
		'Solid infill': 'Internal solid infill',
		'Top solid infill': 'Top surface',
		'Bridge infill': 'Bridge',
		'Gap fill': 'Gap infill',
		'Skirt/Brim': 'Skirt',
		'Support material': 'Support',
		'Support material interface': 'Support interface',
		'Wipe tower': 'Prime tower'
	};
	const ARC_TOLERANCE = 0.0125;

	let cap = 1 << 16;
	let seg = new Float32Array(cap * 6);
	let attr = new Uint8Array(cap * 4);
	let speed = new Uint16Array(cap);
	let n = 0;

	// Machine position, and the offset G92 set (commanded = machine - origin).
	let x = 0,
		y = 0,
		z = 0,
		e = 0;
	let ox = 0,
		oy = 0,
		oz = 0,
		oe = 0;
	let relative = false,
		relativeE = false;
	let feed = 3000; // mm/min
	let accel = 10_000; // mm/s²
	let role = CUSTOM; // the machine start G-code, before the first role
	let beforeFlush = role;
	let wiping = false;
	let tool = 0;
	const used = new Set<number>();
	let width = 0.42,
		height = 0.2;

	interface Layer {
		z: number;
		height: number;
		first: number;
		estStart: number;
	}
	const layers: Layer[] = [];
	let est = 0; // estimated seconds so far
	let endEst: number | null = null; // where the machine end G-code starts
	let total: number | null = null; // the slicer's total, from the header
	let firstR: number | null = null;
	let lastP = -1;
	const percentAt: number[] = []; // est, percent pairs
	let colours: string[] = [],
		types: string[] = [];

	const decoder = new TextDecoder('latin1');
	let rest = '';

	function grow() {
		cap *= 2;
		const s = new Float32Array(cap * 6);
		s.set(seg);
		seg = s;
		const a = new Uint8Array(cap * 4);
		a.set(attr);
		attr = a;
		const v = new Uint16Array(cap);
		v.set(speed);
		speed = v;
	}

	const clamp8 = (mm: number) => Math.max(0, Math.min(255, Math.round(mm * 100)));

	function add(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, f: number) {
		if (n === cap) grow();
		const s = n * 6;
		seg[s] = x0;
		seg[s + 1] = y0;
		seg[s + 2] = z0;
		seg[s + 3] = x1;
		seg[s + 4] = y1;
		seg[s + 5] = z1;
		const a = n * 4;
		const extrusion = f !== TRAVEL && f !== WIPE;
		attr[a] = f;
		attr[a + 1] = tool;
		attr[a + 2] = extrusion ? clamp8(width) : 0;
		attr[a + 3] = extrusion ? clamp8(height) : 0;
		speed[n] = Math.min(65535, Math.round(feed / 60));
		if (extrusion) used.add(tool);
		n++;
	}

	/** Seconds for a move of `d` mm at the current feed: a trapezoid with the current acceleration. */
	function moveTime(d: number) {
		const v = Math.max(feed / 60, 0.1);
		return d >= (v * v) / accel ? d / v + v / accel : 2 * Math.sqrt(d / accel);
	}

	function setRole(name: string) {
		const clean = name.trim();
		const i = features.indexOf(ALIAS[clean] ?? clean);
		role = i < 0 ? 0 : i;
	}

	function newLayer() {
		layers.push({ z: NaN, height: NaN, first: layers.length ? n : 0, estStart: est });
	}

	/** "4h 12m 53s", "2d 3h", "45m 10s" → seconds. */
	function duration(text: string) {
		let s = 0;
		for (const m of text.matchAll(/(\d+)\s*([dhms])/g))
			s += Number(m[1]) * (m[2] === 'd' ? 86400 : m[2] === 'h' ? 3600 : m[2] === 'm' ? 60 : 1);
		return s;
	}

	function comment(c: string) {
		// Bambu writes "; TAG" with a space; others ";TAG".
		const t = c.charCodeAt(1) === 32 ? c.slice(2) : c.slice(1);
		if (t.startsWith('FEATURE: ')) setRole(t.slice(9));
		else if (t.startsWith('TYPE:')) setRole(t.slice(5));
		else if (t === 'CHANGE_LAYER' || t === 'LAYER_CHANGE') newLayer();
		else if (t.startsWith('Z_HEIGHT:') || t.startsWith('Z:')) {
			const layer = layers[layers.length - 1];
			if (layer && Number.isNaN(layer.z)) layer.z = Number(t.slice(t.indexOf(':') + 1));
		} else if (t.startsWith('LAYER_HEIGHT:') || t.startsWith('HEIGHT:')) {
			const v = Number(t.slice(t.indexOf(':') + 1));
			if (v > 0) height = v;
			const layer = layers[layers.length - 1];
			if (layer && Number.isNaN(layer.height) && v > 0) layer.height = v;
		} else if (t.startsWith('LINE_WIDTH:') || t.startsWith('WIDTH:')) {
			const v = Number(t.slice(t.indexOf(':') + 1));
			if (v > 0) width = v;
		} else if (t.startsWith('WIPE_START')) wiping = true;
		else if (t.startsWith('WIPE_END')) wiping = false;
		else if (t.startsWith('FLUSH_START')) {
			beforeFlush = role;
			role = FLUSH;
		} else if (t.startsWith('FLUSH_END')) role = beforeFlush;
		else if (t.startsWith('MACHINE_END_GCODE_START')) endEst = est;
		else if (total === null && t.includes('total estimated time:'))
			total = duration(t.slice(t.indexOf('total estimated time:')));
		else if (total === null && t.startsWith('estimated printing time (normal mode) ='))
			total = duration(t.slice(t.indexOf('=')));
		else if (t.startsWith('filament_colour = ')) colours = t.slice(18).split(';');
		else if (t.startsWith('filament_type = ')) types = t.slice(16).split(';');
	}

	function move(words: string[], arc: 0 | 2 | 3) {
		let X: number | null = null,
			Y: number | null = null,
			Z: number | null = null,
			E: number | null = null,
			I: number | null = null,
			J: number | null = null,
			P: number | null = null;
		for (let i = 1; i < words.length; i++) {
			const w = words[i];
			if (!w) continue;
			const v = Number(w.slice(1));
			if (Number.isNaN(v)) continue;
			switch (w.charCodeAt(0)) {
				case 88: // X
					X = v;
					break;
				case 89:
					Y = v;
					break;
				case 90:
					Z = v;
					break;
				case 69:
					E = v;
					break;
				case 70:
					if (v > 0) feed = v;
					break;
				case 73:
					I = v;
					break;
				case 74:
					J = v;
					break;
				case 80:
					P = v;
					break;
			}
		}
		const nx = X === null ? x : relative ? x + X : ox + X;
		const ny = Y === null ? y : relative ? y + Y : oy + Y;
		const nz = Z === null ? z : relative ? z + Z : oz + Z;
		const ne = E === null ? e : relative || relativeE ? e + E : oe + E;
		const dx = nx - x,
			dy = ny - y,
			dz = nz - z,
			de = ne - e;
		const xy = dx !== 0 || dy !== 0;
		const isArc = arc !== 0 && (I !== null || J !== null);
		if (isArc) {
			const cx = x + (I ?? 0),
				cy = y + (J ?? 0);
			const r = Math.hypot(x - cx, y - cy);
			const a0 = Math.atan2(y - cy, x - cx);
			const ccw = arc === 3;
			let sweep: number;
			if (!xy) sweep = 2 * Math.PI * Math.max(1, P ?? 1);
			else {
				const a1 = Math.atan2(ny - cy, nx - cx);
				sweep = ccw ? a1 - a0 : a0 - a1;
				while (sweep <= 1e-9) sweep += 2 * Math.PI;
			}
			est += moveTime(Math.hypot(sweep * r, dz) || Math.abs(de));
			const f = wiping ? WIPE : de === 0 ? TRAVEL : role;
			const step = r > ARC_TOLERANCE ? 2 * Math.acos((r - ARC_TOLERANCE) / r) : sweep;
			const pieces = Math.min(1000, Math.max(1, Math.ceil(sweep / step)));
			let px = x,
				py = y,
				pz = z;
			for (let i = 1; i <= pieces; i++) {
				let qx: number, qy: number;
				if (i === pieces) {
					qx = nx;
					qy = ny;
				} else {
					const a = a0 + ((ccw ? 1 : -1) * sweep * i) / pieces;
					qx = cx + r * Math.cos(a);
					qy = cy + r * Math.sin(a);
				}
				const qz = z + (dz * i) / pieces;
				add(px, py, pz, qx, qy, qz, f);
				px = qx;
				py = qy;
				pz = qz;
			}
		} else {
			const d = Math.hypot(dx, dy, dz);
			est += moveTime(d || Math.abs(de));
			let f = -1;
			if (wiping) f = xy || dz !== 0 ? WIPE : -1;
			else if (de > 0) f = xy ? role : dz !== 0 ? TRAVEL : -1;
			else if (xy || dz !== 0) f = TRAVEL;
			if (f >= 0) add(x, y, z, nx, ny, nz, f);
		}
		x = nx;
		y = ny;
		z = nz;
		e = ne;
	}

	function param(words: string[], letter: number): number | null {
		for (let i = 1; i < words.length; i++)
			if (words[i].charCodeAt(0) === letter) {
				const v = Number(words[i].slice(1));
				return Number.isNaN(v) ? null : v;
			}
		return null;
	}

	function line(raw: string) {
		let s = raw;
		let c = s.charCodeAt(0);
		if (c === 32 || c === 9) {
			s = s.trimStart();
			c = s.charCodeAt(0);
		}
		if (c === 59) return comment(s.trimEnd()); // ;
		if (c !== 71 && c !== 77 && c !== 84) return; // G, M, T
		const semi = s.indexOf(';');
		const words = (semi >= 0 ? s.slice(0, semi) : s).trim().split(/\s+/);
		const num = Number(words[0].slice(1));
		if (c === 71) {
			if (num === 0 || num === 1) move(words, 0);
			else if (num === 2 || num === 3) move(words, num);
			else if (num === 4) {
				const p = param(words, 80),
					sec = param(words, 83);
				est += sec ?? (p ?? 0) / 1000;
			} else if (num === 28) {
				// Homing ends at 0 on the homed axes (all three when none is named), drawn as a travel like
				// any G1 (process_G28 turns it into "G1 X0 Y0 Z0").
				const axes = words.slice(1).filter((w) => /^[XYZ]/.test(w));
				const named = axes.length ? axes.map((w) => w[0]) : ['X', 'Y', 'Z'];
				move(['G1', ...named.map((a) => `${a}0`)], 0);
			} else if (num === 90) relative = false;
			else if (num === 91) relative = true;
			else if (num === 92) {
				const X = param(words, 88),
					Y = param(words, 89),
					Z = param(words, 90),
					E = param(words, 69);
				if (X !== null) ox = x - X;
				if (Y !== null) oy = y - Y;
				if (Z !== null) oz = z - Z;
				if (E !== null) oe = e - E;
				if (X === null && Y === null && Z === null && E === null) {
					ox = x;
					oy = y;
					oz = z;
					oe = e;
				}
			}
		} else if (c === 77) {
			if (num === 73) {
				const p = param(words, 80),
					r = param(words, 82);
				if (p !== null && r !== null) {
					if (firstR === null) firstR = r;
					if (p > lastP) {
						lastP = p;
						percentAt.push(est, p);
					}
				}
			} else if (num === 82) relativeE = false;
			else if (num === 83) relativeE = true;
			else if (num === 204) {
				const a = param(words, 83);
				if (a && a > 0) accel = a;
			} else if (num === 400) {
				const p = param(words, 80),
					sec = param(words, 83);
				est += sec ?? (p ?? 0) / 1000;
			} else if (num === 1020) {
				const t = param(words, 83);
				if (t !== null && Number.isInteger(t) && t >= 0 && t <= 254) tool = t;
			}
		} else if (Number.isInteger(num) && num >= 0 && num <= 254) tool = num;
	}

	function push(chunk: Uint8Array) {
		const text = rest + decoder.decode(chunk, { stream: true });
		let start = 0;
		for (;;) {
			const end = text.indexOf('\n', start);
			if (end < 0) break;
			line(text.charCodeAt(end - 1) === 13 ? text.slice(start, end - 1) : text.slice(start, end));
			start = end + 1;
		}
		rest = text.slice(start);
	}

	/**
	 * Thins the segments in place to fit the budget; returns what it did. A move shorter than 0.05 mm is
	 * joined to the one before only while the joined line stays short (JOIN_MAX) and the corner it drops
	 * sits within the arc tolerance of it, so fine curves keep their shape instead of turning into one
	 * long chord.
	 */
	function decimate(list: { first: number; count: number }[]) {
		const JOIN_MAX = 0.5;
		const len = (i: number) =>
			Math.hypot(
				seg[i * 6 + 3] - seg[i * 6],
				seg[i * 6 + 4] - seg[i * 6 + 1],
				seg[i * 6 + 5] - seg[i * 6 + 2]
			);
		/** Whether segment p, stretched to where r ends, still passes within tolerance of p's end. */
		const joinable = (p: number, r: number) => {
			const ax = seg[p * 6],
				ay = seg[p * 6 + 1],
				az = seg[p * 6 + 2];
			const dx = seg[r * 6 + 3] - ax,
				dy = seg[r * 6 + 4] - ay,
				dz = seg[r * 6 + 5] - az;
			const chord = Math.hypot(dx, dy, dz);
			if (chord === 0 || chord > JOIN_MAX) return false;
			const px = seg[p * 6 + 3] - ax,
				py = seg[p * 6 + 4] - ay,
				pz = seg[p * 6 + 5] - az;
			// Distance from the dropped corner to the new line: |corner × line| / |line|.
			const cx = py * dz - pz * dy,
				cy = pz * dx - px * dz,
				cz = px * dy - py * dx;
			return Math.hypot(cx, cy, cz) / chord <= ARC_TOLERANCE;
		};
		const pass = (dropTravel: boolean, minLength: number) => {
			let w = 0,
				joined = 0;
			for (const layer of list) {
				const from = layer.first,
					to = layer.first + layer.count;
				layer.first = w;
				for (let r = from; r < to; r++) {
					const f = attr[r * 4];
					if (dropTravel && (f === TRAVEL || f === WIPE)) continue;
					if (minLength > 0 && w > layer.first && len(r) < minLength) {
						const p = w - 1;
						if (
							attr[p * 4] === f &&
							attr[p * 4 + 1] === attr[r * 4 + 1] &&
							attr[p * 4 + 2] === attr[r * 4 + 2] &&
							attr[p * 4 + 3] === attr[r * 4 + 3] &&
							seg[p * 6 + 3] === seg[r * 6] &&
							seg[p * 6 + 4] === seg[r * 6 + 1] &&
							seg[p * 6 + 5] === seg[r * 6 + 2] &&
							joinable(p, r)
						) {
							seg[p * 6 + 3] = seg[r * 6 + 3];
							seg[p * 6 + 4] = seg[r * 6 + 4];
							seg[p * 6 + 5] = seg[r * 6 + 5];
							joined++;
							continue;
						}
					}
					if (w !== r) {
						seg.copyWithin(w * 6, r * 6, r * 6 + 6);
						attr.copyWithin(w * 4, r * 4, r * 4 + 4);
						speed[w] = speed[r];
					}
					w++;
				}
				layer.count = w - layer.first;
			}
			n = w;
			return joined;
		};
		pass(true, 0);
		const joined = n > budget ? pass(false, 0.05) : 0;
		return { travel: true, joined };
	}

	function finish(): PreviewData {
		if (rest) line(rest.endsWith('\r') ? rest.slice(0, -1) : rest);
		rest = '';
		// No layer markers: start a layer wherever extrusion climbs.
		if (!layers.length && n) {
			let top = -Infinity;
			for (let i = 0; i < n; i++) {
				const f = attr[i * 4];
				const zz = seg[i * 6 + 5];
				if (f !== TRAVEL && f !== WIPE && zz > top + 1e-4) {
					top = zz;
					// The travel up to the new height belongs to the new layer.
					let first = i;
					const floor = layers.length ? layers[layers.length - 1].first + 1 : 0;
					while (first > floor && attr[(first - 1) * 4] === TRAVEL) first--;
					layers.push({ z: zz, height: NaN, first: layers.length ? first : 0, estStart: NaN });
				}
			}
			if (!layers.length) layers.push({ z: 0, height: NaN, first: 0, estStart: NaN });
		}
		const list = layers.map((l, i) => ({
			first: l.first,
			count: (i + 1 < layers.length ? layers[i + 1].first : n) - l.first
		}));

		// Layer times: the estimate, pinned to the slicer's own clock (M73 percent points) when known.
		const clock = total ?? (firstR !== null ? firstR * 60 : null);
		const pins: [number, number][] = [[0, 0]];
		if (clock !== null) {
			for (let i = 0; i < percentAt.length; i += 2)
				pins.push([percentAt[i], (percentAt[i + 1] / 100) * clock]);
			pins.push([est, clock]);
		}
		const pinned = pins.filter(
			(p, i) => i === 0 || (p[0] > pins[i - 1][0] && p[1] >= pins[i - 1][1])
		);
		const at = (t: number) => {
			if (clock === null || pinned.length < 2) return t;
			for (let i = 1; i < pinned.length; i++) {
				const [e1, r1] = pinned[i];
				if (t <= e1) {
					const [e0, r0] = pinned[i - 1];
					return r0 + ((t - e0) / (e1 - e0)) * (r1 - r0);
				}
			}
			return pinned[pinned.length - 1][1];
		};
		const seconds = layers.map((l, i) => {
			if (Number.isNaN(l.estStart)) return null;
			const end = i + 1 < layers.length ? layers[i + 1].estStart : (endEst ?? est);
			return Math.round(Math.max(0, at(end) - at(l.estStart)) * 10) / 10;
		});

		const decimated = n > budget ? decimate(list) : undefined;

		let bbox: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
		for (const only of [true, false]) {
			let found = false;
			const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
			for (let i = 0; i < n; i++) {
				const f = attr[i * 4];
				if (only && (f === TRAVEL || f === WIPE)) continue;
				found = true;
				for (let k = 0; k < 6; k += 3) {
					const s = i * 6 + k;
					if (seg[s] < b[0]) b[0] = seg[s];
					if (seg[s + 1] < b[1]) b[1] = seg[s + 1];
					if (seg[s + 2] < b[2]) b[2] = seg[s + 2];
					if (seg[s] > b[3]) b[3] = seg[s];
					if (seg[s + 1] > b[4]) b[4] = seg[s + 1];
					if (seg[s + 2] > b[5]) b[5] = seg[s + 2];
				}
			}
			if (found) {
				bbox = b.map((v) => Math.round(v * 1000) / 1000) as typeof bbox;
				break;
			}
		}

		let prevZ = 0;
		const outLayers = layers.map((l, i) => {
			let zz = l.z;
			if (Number.isNaN(zz)) {
				zz = prevZ;
				for (let s = list[i].first; s < list[i].first + list[i].count; s++)
					if (attr[s * 4] !== TRAVEL && attr[s * 4] !== WIPE) zz = Math.max(zz, seg[s * 6 + 5]);
			}
			const h = Number.isNaN(l.height) ? zz - prevZ : l.height;
			prevZ = zz;
			return {
				z: Math.round(zz * 1000) / 1000,
				height: Math.round(Math.max(0, h) * 1000) / 1000,
				seconds: seconds[i],
				first: list[i].first,
				count: list[i].count
			};
		});

		const toolList = [...(used.size || !n ? used : new Set([0]))].sort((a, b) => a - b);
		const tools = toolList.map((index) => {
			const known = opts.filaments?.find((f) => f.index === index);
			return {
				index,
				color: known?.color || colours[index]?.trim() || '#888888',
				type: known?.type || types[index]?.trim() || ''
			};
		});

		const header: PreviewHeader = {
			version: 1,
			plate: opts.plate,
			source: 'gcode',
			segments: n,
			bbox,
			features: [...features],
			tools,
			layers: outLayers,
			totalSeconds: clock ?? (est > 0 ? Math.round(est) : null)
		};
		if (decimated) header.decimated = decimated;
		return {
			header,
			seg: seg.slice(0, n * 6),
			attr: attr.slice(0, n * 4),
			speed: speed.slice(0, n)
		};
	}

	return { push, finish };
}

/**
 * The 4.7.3 container, byte for byte what encodePreview writes, but with typed-array copies instead of
 * a DataView per number (a 5-million-segment plate is 150 MB of numbers). `travelFeature`: the Travel
 * code, for the flags.
 */
export function packPreview(data: PreviewData, travelFeature: number): Uint8Array {
	const n = data.header.segments;
	if (data.seg.length !== n * 6 || data.attr.length !== n * 4 || data.speed.length !== n)
		throw new Error('Preview: arrays do not match the segment count.');
	const json = new TextEncoder().encode(JSON.stringify(data.header));
	const headerBytes = (json.length + 3) & ~3;
	const start = 12 + headerBytes;
	const out = new Uint8Array(start + n * 28 + ((n * 2 + 3) & ~3));
	const view = new DataView(out.buffer);
	out.set([0x50, 0x4c, 0x50, 0x56], 0); // "PLPV"
	let travel = false;
	for (let i = 0; i < n && !travel; i++) travel = data.attr[i * 4] === travelFeature;
	view.setUint16(4, 1, true);
	view.setUint16(6, travel ? 1 : 0, true);
	view.setUint32(8, headerBytes, true);
	out.set(json, 12);
	out.fill(0x20, 12 + json.length, start);
	const little = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
	if (little) {
		// start and start + 28n are multiples of 4, so both views are aligned.
		new Float32Array(out.buffer, start, n * 6).set(data.seg);
		new Uint16Array(out.buffer, start + n * 28, n).set(data.speed);
	} else {
		for (let i = 0; i < n * 6; i++) view.setFloat32(start + i * 4, data.seg[i], true);
		for (let i = 0; i < n; i++) view.setUint16(start + n * 28 + i * 2, data.speed[i], true);
	}
	out.set(data.attr, start + n * 24);
	return out;
}
