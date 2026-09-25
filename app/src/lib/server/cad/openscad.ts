// OpenSCAD (WebAssembly, Manifold backend) rendering in isolated worker threads, plus the customizer
// parameter parser. Each render gets a fresh instance: startup is ~50 ms and it avoids state leaking
// between runs; a hard timeout terminates runaway models.
import type { Diagnostic, Parameter } from '$lib/shared/cad';
export type { Diagnostic, Parameter };
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../validation';
import { parseStl, type Soup } from './mesh';

/** The bundled engine (openscad-wasm-prebuilt 1.2.0). */
export const OPENSCAD_VERSION = 'OpenSCAD 2025.01.19 (WebAssembly, Manifold backend)';

export interface RenderResult {
	ok: boolean;
	soup: Soup | null;
	diagnostics: Diagnostic[];
	echo: string[];
	ms: number;
}

const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
(async () => {
	const { createOpenSCAD } = await import('openscad-wasm-prebuilt');
	const log = [];
	const o = (await createOpenSCAD({ print: (t) => log.push(t), printErr: (t) => log.push(t) })).getInstance();
	try { o.FS.mkdir('/fonts'); } catch {}
	for (const file of workerData.fonts) o.FS.writeFile('/fonts/' + file.split('/').pop(), fs.readFileSync(file));
	o.FS.writeFile('/model.scad', workerData.source);
	let code;
	try { code = o.callMain(['/model.scad', '--backend=manifold', '--export-format=binstl', ...workerData.defines, '-o', '/model.stl']); }
	catch (e) { code = -1; log.push('ERROR: OpenSCAD stopped unexpectedly.'); }
	let stl = null;
	try { if (code === 0) stl = o.FS.readFile('/model.stl'); } catch {}
	parentPort.postMessage({ code, log, stl }, stl ? [stl.buffer] : []);
})().catch((e) => parentPort.postMessage({ code: -1, log: ['ERROR: ' + (e && e.message || e)], stl: null }));
`;

function fontFiles(): string[] {
	const dir = path.resolve('resources/fonts');
	return fs.existsSync(dir)
		? fs
				.readdirSync(dir)
				.filter((f) => f.endsWith('.ttf'))
				.map((f) => path.join(dir, f))
		: [];
}

function defineArgs(params: Record<string, string | number | boolean>): string[] {
	const args: string[] = [];
	for (const [name, value] of Object.entries(params)) {
		if (!/^[A-Za-z_$][A-Za-z0-9_]*$/.test(name))
			throw new AppError(400, `Invalid parameter name “${name}”.`);
		const literal =
			typeof value === 'string'
				? JSON.stringify(value)
				: typeof value === 'boolean'
					? String(value)
					: Number.isFinite(value)
						? String(value)
						: null;
		if (literal === null) throw new AppError(400, `Invalid value for ${name}.`);
		args.push('-D', `${name}=${literal}`);
	}
	return args;
}

export function parseDiagnostics(log: string[]): { diagnostics: Diagnostic[]; echo: string[] } {
	const diagnostics: Diagnostic[] = [],
		echo: string[] = [];
	for (const raw of log) {
		const line = raw.trim();
		const at = line.match(/line (\d+)/);
		if (/^ERROR:/.test(line))
			diagnostics.push({
				level: 'error',
				message: line.replace(/^ERROR:\s*/, '').replace(/ in file \/model\.scad,?/, ''),
				line: at ? Number(at[1]) : null
			});
		else if (/^WARNING:/.test(line) && !/font/i.test(line))
			diagnostics.push({
				level: 'warning',
				message: line.replace(/^WARNING:\s*/, '').replace(/ in file \/model\.scad,?/, ''),
				line: at ? Number(at[1]) : null
			});
		else if (/^ECHO:/.test(line)) echo.push(line.replace(/^ECHO:\s*/, ''));
		else if (/top level object is empty/i.test(line))
			diagnostics.push({ level: 'error', message: 'The model produced no geometry.', line: null });
	}
	return { diagnostics, echo };
}

export async function renderScad(
	source: string,
	params: Record<string, string | number | boolean> = {},
	timeoutMs = 60_000
): Promise<RenderResult> {
	if (source.length > 200_000) throw new AppError(413, 'That model source is too long.');
	const started = performance.now();
	const defines = defineArgs(params);
	const result = await new Promise<{ code: number; log: string[]; stl: Uint8Array | null }>(
		(resolve) => {
			const worker = new Worker(WORKER, {
				eval: true,
				workerData: { source, defines, fonts: fontFiles() },
				resourceLimits: { maxOldGenerationSizeMb: 1536 }
			});
			const timer = setTimeout(() => {
				void worker.terminate();
				resolve({
					code: -1,
					log: [
						`ERROR: Rendering took longer than ${Math.round(timeoutMs / 1000)} s and was stopped. Lower $fn or simplify the model.`
					],
					stl: null
				});
			}, timeoutMs);
			worker.once('message', (m) => {
				clearTimeout(timer);
				void worker.terminate();
				resolve(m);
			});
			worker.once('error', (e) => {
				clearTimeout(timer);
				resolve({ code: -1, log: [`ERROR: ${e.message}`], stl: null });
			});
		}
	);
	const { diagnostics, echo } = parseDiagnostics(result.log);
	// An unexpected end of file is reported one line past the end; point at the last line that has code.
	const lastLine = source.trimEnd().split('\n').length;
	for (const d of diagnostics)
		if (d.line && d.line > lastLine) {
			d.line = lastLine;
			d.message = d.message.replace(/line \d+$/, `line ${lastLine} (unexpected end of file)`);
		}
	let soup: Soup | null = null;
	if (result.code === 0 && result.stl) {
		try {
			soup = parseStl(Buffer.from(result.stl));
		} catch {
			diagnostics.push({
				level: 'error',
				message: 'OpenSCAD produced an unreadable mesh.',
				line: null
			});
		}
	}
	if (!soup && !diagnostics.some((d) => d.level === 'error'))
		diagnostics.push({
			level: 'error',
			message: 'OpenSCAD could not render this model.',
			line: null
		});
	if (soup && soup.length === 0) {
		soup = null;
		diagnostics.push({ level: 'error', message: 'The model produced no geometry.', line: null });
	}
	return { ok: !!soup, soup, diagnostics, echo, ms: Math.round(performance.now() - started) };
}

// ---------- Customizer parameters ----------

/**
 * Reads OpenSCAD customizer parameters: top-level assignments before the first module or function,
 * with `// [min:max]`, `// [min:step:max]` or `// [a, b:Label]` annotations, `/* [Group] *\/` sections,
 * and `/* [Hidden] *\/` to stop exposing variables. Same conventions as OpenSCAD and MakerWorld.
 */
export function parseParameters(source: string): Parameter[] {
	const params: Parameter[] = [];
	let group = 'Parameters',
		hidden = false,
		pendingDescription = '';
	for (const raw of source.split(/\r?\n/)) {
		const line = raw.trim();
		if (/^(module|function)\s/.test(line)) break;
		const section = line.match(/^\/\*\s*\[(.+?)\]\s*\*\/$/);
		if (section) {
			group = section[1].trim();
			hidden = group.toLowerCase() === 'hidden';
			continue;
		}
		if (line.startsWith('//')) {
			pendingDescription = line.replace(/^\/\/\s*/, '');
			continue;
		}
		const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?);\s*(?:\/\/\s*(.*))?$/);
		if (!m || hidden || m[1].startsWith('$')) {
			if (line) pendingDescription = '';
			continue;
		}
		const [, name, rawValue, comment = ''] = m;
		let value: string | number | boolean;
		let type: Parameter['type'];
		if (/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(rawValue)) {
			value = Number(rawValue);
			type = 'number';
		} else if (rawValue === 'true' || rawValue === 'false') {
			value = rawValue === 'true';
			type = 'boolean';
		} else if (/^".*"$/.test(rawValue)) {
			value = rawValue.slice(1, -1).replace(/\\"/g, '"');
			type = 'string';
		} else {
			pendingDescription = '';
			continue; // expressions and vectors stay in code
		}
		const p: Parameter = { name, type, value, group, description: pendingDescription };
		const annotation = comment.match(/^\[(.*)\]\s*(.*)$/);
		if (annotation) {
			const inner = annotation[1];
			if (annotation[2]) p.description = annotation[2];
			const range = inner.match(/^\s*(-?[\d.]+)\s*:\s*(-?[\d.]+)\s*(?::\s*(-?[\d.]+))?\s*$/);
			if (range && type === 'number') {
				const nums = [range[1], range[2], range[3]].filter((x) => x !== undefined).map(Number);
				if (nums.length === 3) [p.min, p.step, p.max] = nums;
				else [p.min, p.max] = nums;
			} else if (inner.includes(',') || /:/.test(inner)) {
				p.type = 'choice';
				p.options = inner.split(',').map((opt) => {
					const [v, label] = opt.split(':').map((x) => x.trim());
					const val = /^-?[\d.]+$/.test(v) ? Number(v) : v.replace(/^"|"$/g, '');
					return { value: val, label: label ?? String(val) };
				});
			} else if (type === 'number' && /^\s*-?[\d.]+\s*$/.test(inner)) p.max = Number(inner);
		} else if (comment) p.description = comment;
		params.push(p);
		pendingDescription = '';
	}
	return params;
}

export const STARTER_SCAD = `// A parametric starter part. Change the numbers below or ask the AI to redesign it.
/* [Size] */
// Outer width (mm)
width = 60; // [20:1:200]
// Outer depth (mm)
depth = 40; // [20:1:200]
// Height (mm)
height = 30; // [5:1:120]
// Wall thickness (mm)
wall = 2; // [0.8:0.2:6]
// Corner radius (mm)
radius = 4; // [0:0.5:20]

/* [Label] */
label = "";
label_size = 7; // [3:0.5:20]

/* [Hidden] */
$fn = 64;

module rounded_box(w, d, h, r) {
  r2 = max(min(r, w / 2 - 0.01, d / 2 - 0.01), 0.01);
  hull() for (x = [r2, w - r2], y = [r2, d - r2]) translate([x, y, 0]) cylinder(r = r2, h = h);
}

difference() {
  rounded_box(width, depth, height, radius);
  translate([wall, wall, wall]) rounded_box(width - 2 * wall, depth - 2 * wall, height, max(radius - wall, 0.5));
  if (label != "")
    translate([width / 2, 0.6, height / 2]) rotate([90, 0, 0])
      linear_extrude(1) text(label, size = label_size, font = "Liberation Sans:style=Bold", halign = "center", valign = "center");
}
`;
