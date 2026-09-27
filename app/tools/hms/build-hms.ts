// Builds the offline English/French databases: app/resources/hms/hms-{en,fr}.json.gz, the pictures Bambu
// shows with some errors (app/resources/hms/images/*.webp) and app/resources/hms/SOURCES.md.
//   bun run hms:build [--from <bambu studio checkout>] [--allow-unpinned] [--ha <ha-bambulab checkout>]
// Bambu Studio's resources/hms files come from the tag pinned in slicer/upstream.lock (read through
// tools/lib/upstream.ts, so the slicer update workflow moves the texts with the pin); ha-bambulab's
// tables (models Bambu Studio does not bundle: X1, P1, A1) from the commit below, from --ha or GitHub.
// Pictures are shrunk to WebP with the system ffmpeg; without it they are left out.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { readUpstreamLock, repoRoot, upstreamFile, upstreamList } from '../lib/upstream';
import {
	buildDatabase,
	type BambuActionFile,
	type BambuHmsFile,
	type HaHmsFile,
	type HaWikiFile
} from './lib';
import { MODEL_CODES, PRINTER_MODELS } from '../../src/lib/shared/printers/models';

/** ha-bambulab (MIT) at the commit the programme verified against. */
const HA = {
	url: 'https://github.com/greghesp/ha-bambulab',
	commit: '0e027ff135a6d9265cb756d3e246747954c76722',
	dir: 'custom_components/bambu_lab/pybambu/hms_error_text'
};
/**
 * ha-bambulab model names (pybambu/const.py Printers) → HMS device prefix: scripts/update_error_text.py
 * _DEVICE_TYPES, plus the prefixes models.ts documents for the models that list leaves out.
 */
const HA_DEVICES: Record<string, string> = {
	X1: '00M',
	X1C: '00M',
	X1E: '03W',
	A1: '039',
	A1MINI: '030',
	P1P: '01S',
	P1S: '01P',
	P2S: '22E',
	H2S: '093',
	H2D: '094',
	H2DPRO: '239',
	H2C: '31B',
	X2D: '20P',
	A2L: '26A'
};
const LANGUAGES = ['en', 'fr'] as const;
/** Pictures: Bambu shows them at 320×180, so 640 px wide is plenty; each capped, and all together. */
const IMAGE_WIDTH = 640;
const IMAGE_MAX_BYTES = 80_000;
const IMAGES_MAX_BYTES = 3_500_000;
const FFMPEG = process.env.FFMPEG ?? '/usr/bin/ffmpeg';

const args = process.argv.slice(2);
const opt = (name: string) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
};
const from = opt('from');
const haDir = opt('ha');
const allowUnpinned = args.includes('--allow-unpinned');
const root = repoRoot(path.dirname(new URL(import.meta.url).pathname));
if (!root) throw new Error('Run this inside the Family Print Lab repository.');
const outDir = path.join(root, 'app', 'resources', 'hms');
const imageDir = path.join(outDir, 'images');

async function haFile(name: string): Promise<Buffer> {
	const rel = `${HA.dir}/${name}`;
	if (haDir) {
		try {
			return execFileSync('git', ['-C', haDir, 'show', `${HA.commit}:${rel}`], {
				stdio: ['ignore', 'pipe', 'pipe'],
				maxBuffer: 64 * 1024 * 1024
			});
		} catch {
			throw new Error(
				`${haDir} does not have ha-bambulab ${HA.commit.slice(0, 7)}: fetch it first.`
			);
		}
	}
	const url = `https://raw.githubusercontent.com/greghesp/ha-bambulab/${HA.commit}/${rel}`;
	const res = await fetch(url, { headers: { 'user-agent': 'family-print-lab' } });
	if (!res.ok) throw new Error(`Could not download ${url}: HTTP ${res.status}`);
	return Buffer.from(await res.arrayBuffer());
}

function toWebp(png: Buffer, name: string, tmp: string): Buffer | null {
	const src = path.join(tmp, name);
	const dst = src.replace(/\.png$/, '.webp');
	fs.writeFileSync(src, png);
	for (const quality of [70, 55, 40]) {
		try {
			execFileSync(
				FFMPEG,
				[
					'-hide_banner',
					'-loglevel',
					'error',
					'-y',
					'-i',
					src,
					'-vf',
					`scale='min(${IMAGE_WIDTH},iw)':-2`,
					'-c:v',
					'libwebp',
					'-quality',
					String(quality),
					dst
				],
				{ stdio: ['ignore', 'ignore', 'pipe'] }
			);
		} catch (error) {
			console.warn(`  ${name}: ffmpeg failed (${(error as Error).message.split('\n')[0]})`);
			return null;
		}
		const out = fs.readFileSync(dst);
		if (out.length <= IMAGE_MAX_BYTES) return out;
	}
	console.warn(`  ${name}: still over ${IMAGE_MAX_BYTES} bytes as WebP, left out`);
	return null;
}

async function buildLanguage(language: string) {
	const lock = readUpstreamLock(root);
	const up = { from, root, allowUnpinned };
	const names = await upstreamList('resources/hms', up);
	const devices = [
		...new Set(
			names.map((n) => n.match(new RegExp(`^hms_${language}_(\\w{3})\\.json$`))?.[1] ?? '')
		)
	]
		.filter(Boolean)
		.sort();
	if (!devices.length) throw new Error(`No resources/hms/hms_${language}_*.json upstream.`);
	console.log(`Bambu Studio ${lock.tag}: HMS files for ${devices.join(' ')}`);
	const bambu = [];
	for (const device of devices) {
		const info = JSON.parse(
			(await upstreamFile(`resources/hms/hms_${language}_${device}.json`, up)).toString('utf8')
		) as BambuHmsFile;
		const actionName = `hms_action_${device}.json`;
		const actions = names.includes(actionName)
			? (JSON.parse(
					(await upstreamFile(`resources/hms/${actionName}`, up)).toString('utf8')
				) as BambuActionFile)
			: null;
		bambu.push({ device, info, actions });
	}
	const ha = JSON.parse(zlib.gunzipSync(await haFile(`hms_${language}.json.gz`)).toString('utf8'));
	const wiki = JSON.parse(zlib.gunzipSync(await haFile('wiki_links.json.gz')).toString('utf8'));

	// Which models each prefix covers, from the catalogue.
	const byDevice: Record<string, string[]> = {};
	for (const code of MODEL_CODES) {
		const m = PRINTER_MODELS[code];
		if (m.hmsDevice) {
			const list = (byDevice[m.hmsDevice] ??= []);
			if (!list.includes(m.short)) list.push(m.short);
		}
	}

	const sources = [
		{
			name: 'Bambu Studio',
			url: 'https://github.com/bambulab/BambuStudio',
			ref: `${lock.tag} (${lock.commit})`,
			licence: 'AGPL-3.0',
			used: `\`resources/hms/hms_${language}_<device>.json\` and \`hms_action_<device>.json\` for ${devices.join(', ')}; pictures from \`resources/hms/local_image\` (converted to WebP)`
		},
		{
			name: 'ha-bambulab',
			url: HA.url,
			ref: HA.commit,
			licence: 'MIT',
			used: `\`${HA.dir}/hms_${language}.json.gz\` (texts for every model, from Bambu's public HMS query) and \`wiki_links.json.gz\``
		}
	];

	// First pass to learn which pictures are referenced, then convert them and build for real.
	const first = buildDatabase({
		language,
		bambu,
		ha: ha as HaHmsFile,
		wiki: wiki as HaWikiFile,
		haDevices: HA_DEVICES,
		devices: byDevice,
		sources
	});
	fs.mkdirSync(imageDir, { recursive: true });
	const shipped = new Map<string, string>();
	let total = 0;
	if (fs.existsSync(FFMPEG)) {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fpl-hms-'));
		try {
			for (const name of first.imageNames) {
				// Pictures are shared by every language; preserve the already shipped English assets.
				const existing = name.replace(/\.png$/, '.webp');
				const target = path.join(imageDir, existing);
				if (fs.existsSync(target)) {
					shipped.set(name, existing);
					total += fs.statSync(target).size;
					continue;
				}
				let png: Buffer;
				try {
					png = await upstreamFile(`resources/hms/local_image/${name}`, up);
				} catch {
					console.warn(`  ${name}: not in resources/hms/local_image`);
					continue;
				}
				const webp = toWebp(png, name, tmp);
				if (!webp) continue;
				if (total + webp.length > IMAGES_MAX_BYTES) {
					console.warn(`  ${name}: over the pictures budget, left out`);
					continue;
				}
				const out = name.replace(/\.png$/, '.webp');
				fs.writeFileSync(path.join(imageDir, out), webp);
				shipped.set(name, out);
				total += webp.length;
			}
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	} else console.warn(`No ffmpeg at ${FFMPEG}: pictures left out.`);

	const { file, unknownModels } = buildDatabase({
		language,
		bambu,
		ha: ha as HaHmsFile,
		wiki: wiki as HaWikiFile,
		haDevices: HA_DEVICES,
		devices: byDevice,
		sources,
		images: (name) => shipped.get(name) ?? null
	});
	if (unknownModels.length)
		console.warn(
			`ha-bambulab models without a device prefix (skipped): ${unknownModels.join(', ')}`
		);
	const json = Buffer.from(JSON.stringify(file));
	const gz = zlib.gzipSync(json, { level: 9 });
	fs.writeFileSync(path.join(outDir, `hms-${language}.json.gz`), gz);

	console.log(
		`Wrote hms-${language}.json.gz (${(gz.length / 1024).toFixed(0)} KB; ${Object.keys(file.hms).length} HMS codes, ${Object.keys(file.errors).length} print errors, ${file.messages.length} texts) and ${shipped.size} pictures (${(total / 1024).toFixed(0)} KB).`
	);
	return sourcesMd(file, lock.tag, devices, shipped.size, total);
}

function sourcesMd(
	file: ReturnType<typeof buildDatabase>['file'],
	tag: string,
	bambuDevices: string[],
	pictures: number,
	bytes: number
) {
	return `## ${file.language === 'fr' ? 'French' : 'English'}

Generated by \`app/tools/hms/build-hms.ts\` (\`bun run hms:build\`); do not edit by hand. The slicer
update workflow reruns it when \`slicer/upstream.lock\` moves, so these texts follow the pinned Bambu
Studio version (${tag}).

${file.sources.map((s) => `- [${s.name}](${s.url}) at \`${s.ref}\` (${s.licence}): ${s.used}.`).join('\n')}

- \`hms-${file.language}.json.gz\`: data version ${file.version}, ${Object.keys(file.hms).length} HMS codes, ${Object.keys(file.errors).length} print errors, ${Object.keys(file.wiki).length} wiki links.
- \`images/\`: ${pictures} pictures (${Math.round(bytes / 1024)} KB), Bambu Studio's \`resources/hms/local_image\` PNGs shrunk to WebP.

Bambu Studio's files win for the devices they cover (${bambuDevices
		.map((d) => `${d} ${(file.devices[d] ?? ['?']).join('/')}`)
		.join(', ')}); ha-bambulab's
tables fill in the rest. Bambu Studio is AGPL-3.0 like Family Print Lab; ha-bambulab is MIT
(Copyright (c) Greg Hesp and contributors).
`;
}

async function main() {
	const sources = [];
	for (const language of LANGUAGES) sources.push(await buildLanguage(language));
	fs.writeFileSync(
		path.join(outDir, 'SOURCES.md'),
		'# Printer error help: sources\n\n' + sources.join('\n')
	);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
