// Sliced print files (.gcode.3mf, as Bambu Studio and OrcaSlicer export them): reading what a plate
// needs (time, weight, filaments, thumbnail) and, for the simulator and tests, making a small fake one.
// The printer only prints these; an STL or unsliced 3MF must go through a slicer first.
import crypto from 'node:crypto';
import { readZip, writeZip } from '../cad/mesh';
import { AppError } from '../validation';
import type { SlicedFilament, SlicedPlate } from '$lib/shared/domain';

export interface SlicedFile {
	plates: SlicedPlate[];
	/** Printer model code the file was sliced for (e.g. "N6" for the X2D), when recorded. */
	printerModelId: string;
	/** Slicer name and version, e.g. "BambuStudio 02.08.02.61". */
	slicer: string;
	thumbnails: Map<number, Buffer>;
}

/** Model codes Bambu Studio writes into sliced files. */
export const PRINTER_MODEL_IDS: Record<string, string> = {
	N6: 'Bambu Lab X2D',
	O1D: 'Bambu Lab H2D',
	O1S: 'Bambu Lab H2S',
	N7: 'Bambu Lab P2S',
	C11: 'Bambu Lab P1P',
	C12: 'Bambu Lab P1S',
	'BL-P001': 'Bambu Lab X1 Carbon',
	N1: 'Bambu Lab A1 mini',
	N2S: 'Bambu Lab A1'
};

const attr = (tag: string, name: string) =>
	tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? '';

/** Reads a sliced .gcode.3mf. Throws a friendly error for files that were never sliced. */
export function readSliced(buf: Buffer): SlicedFile {
	const files = readZip(buf, (name) => {
		if (/^Metadata\/plate_\d+\.gcode$/.test(name)) return 'head';
		if (/^Metadata\/(slice_info\.config|plate_\d+\.png|plate_\d+\.gcode\.md5)$/.test(name))
			return 'all';
		return false;
	});
	const gcodes = [...files.keys()].filter((n) => n.endsWith('.gcode'));
	if (!gcodes.length)
		throw new AppError(
			400,
			'That 3MF has not been sliced. In Bambu Studio, slice the plate and use “Export plate sliced file”.'
		);
	const info = files.get('Metadata/slice_info.config')?.toString('utf8') ?? '';
	const header = (key: string) =>
		info.match(new RegExp(`header_item key="${key}" value="([^"]*)"`))?.[1] ?? '';
	const plateBlocks = new Map<number, string>();
	for (const m of info.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
		const index = Number(m[1].match(/key="index" value="(\d+)"/)?.[1]);
		if (index) plateBlocks.set(index, m[1]);
	}
	let printerModelId = '';
	const plates: SlicedPlate[] = gcodes
		.map((name) => {
			const index = Number(name.match(/plate_(\d+)\.gcode$/)![1]);
			const block = plateBlocks.get(index) ?? '';
			const meta = (key: string) =>
				block.match(new RegExp(`key="${key}" value="([^"]*)"`))?.[1] ?? '';
			printerModelId ||= meta('printer_model_id');
			const head = files.get(name)!.toString('utf8');
			const fromHead = (label: RegExp) => head.match(label)?.[1];
			const seconds =
				Number(meta('prediction')) || parseDuration(fromHead(/total estimated time: ([^;\n]+)/));
			const filaments: SlicedFilament[] = [...block.matchAll(/<filament\b[^>]*\/?>/g)].map((f) => ({
				id: Number(attr(f[0], 'id')) || 0,
				type: attr(f[0], 'type') || 'PLA',
				color: attr(f[0], 'color') || '#888888',
				grams: Number(attr(f[0], 'used_g')) || 0,
				meters: Number(attr(f[0], 'used_m')) || 0
			}));
			const grams =
				Number(meta('weight')) ||
				filaments.reduce((a, f) => a + f.grams, 0) ||
				Number(fromHead(/total filament weight \[g\] : ([\d.]+)/)) ||
				0;
			return {
				index,
				gcode: name,
				md5: files.get(`${name}.md5`)?.toString('utf8').trim().toUpperCase() ?? '',
				minutes: Math.max(1, Math.round(seconds / 60)),
				grams: Math.round(grams * 10) / 10,
				layers: Number(fromHead(/total layer number: (\d+)/)) || 0,
				supports: meta('support_used') === 'true',
				filaments
			};
		})
		.sort((a, b) => a.index - b.index);
	const thumbnails = new Map<number, Buffer>();
	for (const [name, data] of files) {
		const m = name.match(/^Metadata\/plate_(\d+)\.png$/);
		if (m) thumbnails.set(Number(m[1]), data);
	}
	const client = [header('X-BBL-Client-Type'), header('X-BBL-Client-Version')]
		.filter(Boolean)
		.join(' ');
	return { plates, printerModelId, slicer: client, thumbnails };
}

/** "1h 20m 5s", "2d 3h", "45m 10s" → seconds. */
function parseDuration(text: string | undefined): number {
	if (!text) return 0;
	let s = 0;
	for (const [, n, unit] of text.matchAll(/(\d+)\s*([dhms])/g))
		s += Number(n) * { d: 86400, h: 3600, m: 60, s: 1 }[unit as 'd' | 'h' | 'm' | 's'];
	return s;
}

/**
 * A small but well-formed sliced file for the simulator and tests: real container layout, a G-code
 * header like Bambu Studio's, slice_info with time and weight, an MD5 and an optional thumbnail.
 */
export function fakeSliced(opts: {
	minutes: number;
	grams: number;
	layers?: number;
	printerModelId?: string;
	filaments?: { type: string; color: string; grams: number }[];
	thumbnail?: Buffer;
}): Buffer {
	const layers = opts.layers ?? 120;
	const filaments = opts.filaments ?? [{ type: 'PLA', color: '#2B2F36', grams: opts.grams }];
	const gcode = Buffer.from(
		[
			'; HEADER_BLOCK_START',
			'; BambuStudio 02.08.02.61',
			`; model printing time: ${Math.floor(opts.minutes / 60)}h ${opts.minutes % 60}m 0s; total estimated time: ${Math.floor(opts.minutes / 60)}h ${opts.minutes % 60}m 0s`,
			`; total layer number: ${layers}`,
			`; total filament weight [g] : ${opts.grams}`,
			'; HEADER_BLOCK_END',
			...Array.from(
				{ length: layers },
				(_, i) => `; layer ${i + 1}\nG1 Z${((i + 1) * 0.2).toFixed(2)}`
			),
			''
		].join('\n')
	);
	const md5 = crypto.createHash('md5').update(gcode).digest('hex').toUpperCase();
	const info = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header>
    <header_item key="X-BBL-Client-Type" value="slicer"/>
    <header_item key="X-BBL-Client-Version" value="02.08.02.61"/>
  </header>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="printer_model_id" value="${opts.printerModelId ?? 'N6'}"/>
    <metadata key="nozzle_diameters" value="0.4"/>
    <metadata key="prediction" value="${opts.minutes * 60}"/>
    <metadata key="weight" value="${opts.grams}"/>
    <metadata key="support_used" value="false"/>
${filaments.map((f, i) => `    <filament id="${i + 1}" type="${f.type}" color="${f.color}" used_m="${(f.grams / 3).toFixed(2)}" used_g="${f.grams}"/>`).join('\n')}
  </plate>
</config>`;
	const entries: [string, Buffer][] = [
		[
			'[Content_Types].xml',
			Buffer.from(
				'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="gcode" ContentType="text/x.gcode"/></Types>'
			)
		],
		[
			'_rels/.rels',
			Buffer.from(
				'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'
			)
		],
		[
			'3D/3dmodel.model',
			Buffer.from(
				'<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources/><build/></model>'
			)
		],
		['Metadata/plate_1.gcode', gcode],
		['Metadata/plate_1.gcode.md5', Buffer.from(md5)],
		['Metadata/slice_info.config', Buffer.from(info)]
	];
	if (opts.thumbnail) entries.push(['Metadata/plate_1.png', opts.thumbnail]);
	return writeZip(entries);
}
