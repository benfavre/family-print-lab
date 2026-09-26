// Regenerates src/lib/shared/printers/models.generated.ts from Bambu Studio's per-model capability
// files (resources/printers/<model_id>.json) at the tag pinned in slicer/upstream.lock.
//   bunx tsx tools/gen-printer-models.ts [--from <bambu studio checkout>] [--strict]
// --strict exits non-zero when upstream has a model code the catalogue (MODEL_CODES) lacks, so a new
// Bambu printer is noticed instead of silently dropped (the slicer update workflow runs it that way).
import fs from 'node:fs';
import path from 'node:path';
import { readUpstreamLock, repoRoot, upstreamFile, upstreamList } from './lib/upstream';

type Json = Record<string, unknown>;

const args = process.argv.slice(2);
const opt = (name: string) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
};
const from = opt('from');
const strict = args.includes('--strict');
const root = repoRoot(path.dirname(new URL(import.meta.url).pathname));
if (!root) throw new Error('Run this inside the Family Print Lab repository.');
const modelsFile = path.join(root, 'app', 'src', 'lib', 'shared', 'printers', 'models.ts');
const outFile = path.join(root, 'app', 'src', 'lib', 'shared', 'printers', 'models.generated.ts');

// The catalogue's codes, read from models.ts (it imports this file's output, so it is not imported here).
const codes = [
	...(fs
		.readFileSync(modelsFile, 'utf8')
		.match(/MODEL_CODES = \[([\s\S]*?)\]/)?.[1]
		.matchAll(/'([^']+)'/g) ?? [])
].map((m) => m[1]);
if (!codes.length) throw new Error('Could not read MODEL_CODES from models.ts.');

/** Capability keys as Bambu Studio's DeviceManager/DevConfig read them, mapped to ours. */
const FLAGS: Record<string, string> = {
	chamberTempEdit: 'support_chamber_temp_edit',
	auxFan: 'support_aux_fan',
	chamberFan: 'support_chamber_fan',
	lidar: 'support_lidar_calibration',
	aiMonitoring: 'support_ai_monitoring',
	firstLayerInspect: 'support_first_layer_inspect',
	buildPlateMarkerDetect: 'support_build_plate_marker_detect',
	amsHumidity: 'support_ams_humidity',
	amsSwitchCommand: 'support_command_ams_switch',
	timelapse: 'support_timelapse',
	sendToSd: 'support_send_to_sd',
	printWithoutSd: 'support_print_without_sd',
	motorNoiseCali: 'support_motor_noise_cali',
	flowCalibration: 'support_flow_calibration',
	autoFlowCalibration: 'support_auto_flow_calibration',
	nozzleOffsetCalibration: 'support_nozzle_offset_calibration',
	userPreset: 'support_user_preset'
};

function caps(print: Json, base: boolean): Record<string, boolean> {
	const out: Record<string, boolean> = {};
	for (const [ours, theirs] of Object.entries(FLAGS)) {
		if (typeof print[theirs] === 'boolean') out[ours] = print[theirs] as boolean;
		else if (base) out[ours] = false;
	}
	// DevConfig.cpp ParseChamberConfig: an explicit display flag, else the chamber itself (X1 reports chamber_temper).
	if (typeof print.support_chamber_temp_display === 'boolean')
		out.chamberTempDisplay = print.support_chamber_temp_display;
	else if (typeof print.support_chamber === 'boolean')
		out.chamberTempDisplay = print.support_chamber;
	else if (base) out.chamberTempDisplay = false;
	if (typeof print.support_bed_leveling === 'number')
		out.bedLeveling = print.support_bed_leveling > 0;
	else if (base) out.bedLeveling = false;
	return out;
}

const range = (v: unknown, i: number) =>
	Array.isArray(v) && typeof v[i] === 'number' ? (v[i] as number) : null;

async function main() {
	const lock = readUpstreamLock(root);
	const files = (await upstreamList('resources/printers', { from, root })).filter((f) =>
		/^[\w-]+\.json$/.test(f)
	);
	const upstreamCodes: string[] = [];
	const models: Record<string, unknown> = {};
	for (const file of files) {
		const data = JSON.parse(
			(await upstreamFile(`resources/printers/${file}`, { from, root })).toString('utf8')
		) as Record<string, Json>;
		const base = data['00.00.00.00'];
		if (!base || typeof base.model_id !== 'string') continue;
		const code = base.model_id;
		upstreamCodes.push(code);
		if (!codes.includes(code)) continue;
		const print = (base.print ?? {}) as Json;
		const ipcam = (print.ipcam ?? {}) as Json;
		const liveview = (ipcam.liveview ?? {}) as Json;
		const versions = Object.keys(data)
			.filter((k) => k !== '00.00.00.00' && /^\d{2}\.\d{2}\.\d{2}\.\d{2}$/.test(k))
			.sort();
		models[code] = {
			code,
			displayName: base.display_name,
			enclosed: base.printer_is_enclosed === true,
			// DeviceManager.hpp BED_TEMP_LIMIT (120) when the file names no limit; StatusPanel.cpp prefers bed_temp_range.
			nozzleTempMax: range(print.nozzle_temp_range, 1) ?? 300,
			bedTempMax:
				range(print.bed_temp_range, 1) ??
				(typeof print.bed_temperature_limit === 'number' ? print.bed_temperature_limit : 120),
			chamberTempMax: range(print.support_chamber_temp_edit_range, 1),
			liveviewLocal: typeof liveview.local === 'string' ? liveview.local : null,
			ftpFolder: typeof base.ftp_folder === 'string' ? base.ftp_folder : null,
			caps: caps(print, true),
			firmwareCaps: versions
				.map((v) => ({ from: v, caps: caps((data[v].print ?? {}) as Json, false) }))
				.filter((f) => Object.keys(f.caps).length)
		};
	}
	const missing = [...new Set(upstreamCodes)].filter((c) => !codes.includes(c));
	const absent = codes.filter((c) => !models[c]);
	const out = `// GENERATED by app/tools/gen-printer-models.ts from Bambu Studio ${lock.tag}
// (commit ${lock.commit}), resources/printers/*.json. Bambu Studio is AGPL-3.0, like this app.
// Do not edit: change the generator or the pin in slicer/upstream.lock and run it again.

export const UPSTREAM_PRINTERS = ${JSON.stringify({ tag: lock.tag, commit: lock.commit })} as const;

/** Capability flags as the upstream files state them (keys of \`Capabilities\` in models.ts). */
export type GeneratedCaps = Record<string, boolean>;

export interface GeneratedModel {
	code: string;
	displayName: string;
	enclosed: boolean;
	nozzleTempMax: number;
	bedTempMax: number;
	chamberTempMax: number | null;
	/** print.ipcam.liveview.local ("local" = the port-6000 JPEG stream). */
	liveviewLocal: string | null;
	ftpFolder: string | null;
	caps: GeneratedCaps;
	/** Later firmware keys, ascending; Bambu Studio itself only reads "00.00.00.00" at this tag. */
	firmwareCaps: { from: string; caps: GeneratedCaps }[];
}

export const GENERATED_MODELS: Record<string, GeneratedModel> = ${JSON.stringify(models, null, '\t')};
`;
	// Formatted like the rest of the code base, so a regeneration only shows real changes.
	const prettier = await import('prettier');
	const config = (await prettier.resolveConfig(outFile)) ?? {};
	fs.writeFileSync(outFile, await prettier.format(out, { ...config, filepath: outFile }));
	console.log(`Wrote ${path.relative(root!, outFile)}: ${Object.keys(models).length} models.`);
	if (absent.length) console.log(`Catalogue codes without an upstream file: ${absent.join(', ')}`);
	if (missing.length) {
		console.log(`Upstream model codes missing from MODEL_CODES: ${missing.join(', ')}`);
		if (strict) process.exit(1);
	}
}

await main();
