// A fake Bambu Studio install for tests: an executable AppRun that runs fake-bambu-cli.mjs, and a
// resources/profiles/BBL tree shaped like Bambu Studio's (machine model files with model_id, "<model>
// <nozzle> nozzle" machine presets inheriting a common one, processes and filaments that list their
// compatible printers) for every model in the catalogue.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MODEL_CODES, PRINTER_MODELS } from '$lib/shared/printers/models';

export const FAKE_CLI = path.join(import.meta.dirname, 'fake-bambu-cli.mjs');

export interface FakeInstall {
	dir: string;
	/** The executable, named like an unpacked AppImage (…/bambu-studio-02.08.02.61/AppRun). */
	bin: string;
	resources: string;
	/** One JSON line per run of the fake CLI. */
	log: string;
	runs(): {
		args: string[];
		machine: Record<string, unknown>;
		process: Record<string, unknown>;
		filaments: Record<string, unknown>[];
		/** Each input STL's bounds as loaded: [minX, minY, minZ, maxX, maxY, maxZ]. */
		inputs: number[][];
	}[];
	remove(): void;
}

export function fakeInstall(): FakeInstall {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpl-bambu-'));
	const app = path.join(dir, 'bambu-studio-02.08.02.61');
	const resources = path.join(app, 'resources');
	const bbl = path.join(resources, 'profiles', 'BBL');
	const log = path.join(dir, 'runs.jsonl');
	for (const sub of ['machine', 'process', 'filament']) fs.mkdirSync(path.join(bbl, sub), { recursive: true });
	const write = (sub: string, data: Record<string, unknown>) =>
		fs.writeFileSync(path.join(bbl, sub, `${data.name}.json`), JSON.stringify(data));
	fs.writeFileSync(`${bbl}.json`, JSON.stringify({ name: 'Bambulab', version: '02.08.00.05' }));
	write('machine', {
		type: 'machine',
		name: 'fdm_machine_common',
		instantiation: 'false',
		nozzle_diameter: ['0.4'],
		printable_area: ['0x0', '256x0', '256x256', '0x256']
	});
	write('process', {
		type: 'process',
		name: 'fdm_process_common',
		instantiation: 'false',
		layer_height: '0.2',
		sparse_infill_density: '15%',
		enable_support: '0'
	});
	write('filament', {
		type: 'filament',
		name: 'Bambu PLA Basic @base',
		instantiation: 'false',
		filament_id: 'GFA00',
		filament_type: ['PLA'],
		filament_colour: ['#FFFFFF']
	});
	write('filament', {
		type: 'filament',
		name: 'Bambu PETG HF @base',
		instantiation: 'false',
		filament_id: 'GFG02',
		filament_type: ['PETG'],
		filament_colour: ['#FFFFFF']
	});
	const names = new Set<string>();
	for (const code of MODEL_CODES) {
		const m = PRINTER_MODELS[code];
		// The H2C has two codes and one set of presets (model_id O1C2 at the pin).
		if (names.has(m.name)) continue;
		names.add(m.name);
		write('machine', { type: 'machine', name: m.name, model_id: code, nozzle_diameter: '0.4;0.2' });
		const machine = `${m.name} 0.4 nozzle`;
		write('machine', {
			type: 'machine',
			name: machine,
			inherits: 'fdm_machine_common',
			from: 'system',
			instantiation: 'true',
			printer_model: m.name
		});
		for (const h of ['0.20', '0.16'])
			write('process', {
				type: 'process',
				name: `${h}mm Standard @BBL ${m.short}`,
				inherits: 'fdm_process_common',
				instantiation: 'true',
				layer_height: String(Number(h)),
				compatible_printers: [machine]
			});
		write('filament', {
			type: 'filament',
			name: `Bambu PLA Basic @BBL ${m.short}`,
			inherits: 'Bambu PLA Basic @base',
			instantiation: 'true',
			compatible_printers: [machine]
		});
		write('filament', {
			type: 'filament',
			name: `Bambu PETG HF @BBL ${m.short}`,
			inherits: 'Bambu PETG HF @base',
			instantiation: 'true',
			compatible_printers: [machine]
		});
	}
	const bin = path.join(app, 'AppRun');
	fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "$@"\n`);
	fs.chmodSync(bin, 0o755);
	return {
		dir,
		bin,
		resources,
		log,
		runs: () =>
			fs.existsSync(log)
				? fs
						.readFileSync(log, 'utf8')
						.trim()
						.split('\n')
						.map((l) => JSON.parse(l))
				: [],
		remove: () => fs.rmSync(dir, { recursive: true, force: true })
	};
}
