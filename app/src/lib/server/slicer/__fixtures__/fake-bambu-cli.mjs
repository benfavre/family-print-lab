// A fake Bambu Studio command line for cli.test.ts and the service tests: takes the options
// CliEngine passes (see cli.ts), checks the preset files the way BambuStudio.cpp load_config_file does
// (name, from, type), and writes what the real one writes: out/result.json (record_exit_reson) and a
// 3MF with one object per input (bbs_3mf.cpp), sliced with a plate G-code when --slice is given.
// Like the real CLI it leaves printer_model_id blank and writes no plate picture.
//   FAKE_CLI_LOG   append one JSON line per run: { args, machine, process, filaments, inputs }
//   FAKE_CLI_FAIL  1: answer with return_code -50 and an error string
//   FAKE_CLI_SLOW  milliseconds to wait before finishing (cancel tests)
// It moves objects the way the real one does (Model.cpp, BambuStudio.cpp, Orient.cpp): an STL's mesh
// is centred into its volume (ModelVolume::center_geometry_after_creation) and set on the bed
// (ensure_on_bed); orienting rotates the volumes, not the instance (ModelObject::rotate), here 90°
// about X, and centres them again; arranging moves the instance, here object i to (60 + 70·i, 100).
// STL inputs are arranged unless --arrange 0 (need_arrange starts true for them). The 3MF keeps the
// volume matrix on the component and the instance matrix on the build item, like the real exporter.
// A slice fails, as the real one does, when an object is not on the plate (printable_area).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const argv = process.argv.slice(2);
const opts = {};
const inputs = [];
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (!a.startsWith('--')) {
		inputs.push(a);
		continue;
	}
	const [key, inline] = a.slice(2).split('=');
	opts[key] = inline ?? argv[++i];
}

const out = opts.outputdir ?? '.';
fs.mkdirSync(out, { recursive: true });
const result = (code, error, plates = []) =>
	fs.writeFileSync(
		path.join(out, 'result.json'),
		JSON.stringify({ plate_index: 0, return_code: code, error_string: error, sliced_plates: plates })
	);

const load = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const [machineFile, processFile] = (opts['load-settings'] ?? '').split(';');
const machine = load(machineFile);
const proc = load(processFile);
const filaments = (opts['load-filaments'] ?? '').split(';').filter(Boolean).map(load);
for (const [p, type] of [
	[machine, 'machine'],
	[proc, 'process'],
	...filaments.map((f) => [f, 'filament'])
])
	if (!p.name || p.from !== 'system' || p.type !== type) {
		result(-5, `bad preset file (${type})`);
		process.exit(1);
	}

// Row-vector 3MF transforms (12 numbers, translation last), as cli.ts uses them.
const compose = (a, b) => {
	const out = [];
	for (let r = 0; r < 4; r++)
		for (let c = 0; c < 3; c++)
			out.push(
				(r < 3 ? 0 : b[9 + c]) + a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
			);
	return out;
};
const move = (x, y, z) => [1, 0, 0, 0, 1, 0, 0, 0, 1, x, y, z];
const bbox = (points, t) => {
	const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
	for (const [x, y, z] of points) {
		const p = [0, 1, 2].map((k) => x * t[k] + y * t[3 + k] + z * t[6 + k] + t[9 + k]);
		for (let k = 0; k < 3; k++) {
			b[k] = Math.min(b[k], p[k]);
			b[k + 3] = Math.max(b[k + 3], p[k]);
		}
	}
	return b;
};
const centre = (b) => [0, 1, 2].map((k) => (b[k] + b[k + 3]) / 2);

// Each input: its vertices, then the volume and instance matrices after loading.
const objects = inputs.map((input) => {
	const b = fs.readFileSync(input);
	const points = [];
	for (let t = 0, n = b.readUInt32LE(80); t < n; t++)
		for (let v = 0; v < 3; v++) {
			const at = 84 + t * 50 + 12 + v * 12;
			points.push([b.readFloatLE(at), b.readFloatLE(at + 4), b.readFloatLE(at + 8)]);
		}
	const loaded = bbox(points, move(0, 0, 0));
	const c = centre(loaded);
	return {
		raw: points.map(([x, y, z]) => [x - c[0], y - c[1], z - c[2]]),
		volume: move(...c),
		instance: move(0, 0, -loaded[2]),
		loaded
	};
});

if (process.env.FAKE_CLI_LOG)
	fs.appendFileSync(
		process.env.FAKE_CLI_LOG,
		`${JSON.stringify({ args: argv, machine, process: proc, filaments, inputs: objects.map((o) => o.loaded) })}\n`
	);

const finish = () => {
	if (process.env.FAKE_CLI_FAIL === '1') {
		result(-50, 'Nothing to be sliced, either the print is empty or no object is fully inside the plate boundary.');
		process.exit(1);
	}
	const arrange = opts.arrange === undefined ? inputs.length > 0 : opts.arrange !== '0';
	objects.forEach((o, i) => {
		if (opts.orient === '1') {
			o.volume = compose(o.volume, [1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 0, 0]);
			const c = centre(bbox(o.raw, o.volume));
			o.volume = compose(o.volume, move(-c[0], -c[1], -c[2]));
			o.instance = move(o.instance[9], o.instance[10], -bbox(o.raw, o.volume)[2]);
		}
		if (arrange) {
			const c = centre(bbox(o.raw, compose(o.volume, move(0, 0, o.instance[11]))));
			o.instance = move(60 + 70 * i - c[0], 100 - c[1], o.instance[11]);
		}
		o.world = bbox(o.raw, compose(o.volume, o.instance));
	});
	const entries = [
		['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types/>'],
		[
			'3D/3dmodel.model',
			`<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
 <resources>
${objects
	.map(
		(o, i) =>
			`  <object id="${i + 1}" type="model">\n   <components>\n    <component p:path="/3D/Objects/object_${i + 1}.model" objectid="${100 + i}" transform="${o.volume.join(' ')}"/>\n   </components>\n  </object>`
	)
	.join('\n')}
 </resources>
 <build>
${objects.map((o, i) => `  <item objectid="${i + 1}" transform="${o.instance.join(' ')}" printable="1"/>`).join('\n')}
 </build>
</model>
`
		]
	];
	// Nothing is sliced when an object is off the plate.
	const area = [].concat(machine.printable_area ?? ['0x0', '256x0', '256x256', '0x256']).map((p) => String(p).split('x').map(Number));
	const [minX, maxX] = [Math.min(...area.map((p) => p[0])), Math.max(...area.map((p) => p[0]))];
	const [minY, maxY] = [Math.min(...area.map((p) => p[1])), Math.max(...area.map((p) => p[1]))];
	if (
		opts.slice !== undefined &&
		objects.some((o) => o.world[0] < minX - 0.01 || o.world[3] > maxX + 0.01 || o.world[1] < minY - 0.01 || o.world[4] > maxY + 0.01)
	) {
		result(-50, 'Nothing to be sliced, either the print is empty or no object is fully inside the plate boundary.');
		process.exit(1);
	}
	const top = Math.max(0, ...objects.map((o) => o.world[5] - o.world[2]));
	const plates = [];
	if (opts.slice !== undefined) {
		const layers = Math.max(1, Math.round(top / Number(proc.layer_height ?? '0.2')));
		const seconds = 600 + layers * 6;
		const used = filaments.map((_, i) => (i === 0 ? 4.25 : 0));
		const gcode = [
			'; HEADER_BLOCK_START',
			'; BambuStudio 02.08.02.61',
			`; total estimated time: ${Math.floor(seconds / 60)}m ${seconds % 60}s`,
			`; total layer number: ${layers}`,
			'; HEADER_BLOCK_END',
			'G28',
			''
		].join('\n');
		const md5 = crypto.createHash('md5').update(gcode).digest('hex').toUpperCase();
		const info = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header>
    <header_item key="X-BBL-Client-Type" value="slicer"/>
    <header_item key="X-BBL-Client-Version" value="02.08.02.61"/>
  </header>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="printer_model_id" value=""/>
    <metadata key="nozzle_diameters" value="${[].concat(machine.nozzle_diameter ?? '0.4')[0]}"/>
    <metadata key="prediction" value="${seconds}"/>
    <metadata key="weight" value="${used.reduce((a, g) => a + g, 0)}"/>
    <metadata key="support_used" value="${proc.enable_support === '1'}"/>
${filaments
	.map(
		(f, i) =>
			`    <filament id="${i + 1}" type="${[].concat(f.filament_type ?? 'PLA')[0]}" color="${[].concat(f.filament_colour ?? '#FFFFFF')[0]}" used_m="${(used[i] / 3).toFixed(2)}" used_g="${used[i]}"/>`
	)
	.join('\n')}
  </plate>
</config>`;
		entries.push(
			['Metadata/plate_1.gcode', gcode],
			['Metadata/plate_1.gcode.md5', md5],
			['Metadata/slice_info.config', info]
		);
		plates.push({
			id: 1,
			total_predication: seconds,
			main_predication: seconds - 60,
			warning_message: '',
			filaments: filaments.map((f, i) => ({ id: i, filament_id: f.filament_id ?? '', total_used_g: used[i] }))
		});
	}
	fs.writeFileSync(path.join(out, opts['export-3mf']), zip(entries));
	result(0, 'Success.', plates);
};

function zip(entries) {
	const chunks = [];
	const central = [];
	let offset = 0;
	for (const [name, text] of entries) {
		const data = Buffer.from(text);
		const n = Buffer.from(name);
		const crc = zlib.crc32(data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(n.length, 26);
		const dir = Buffer.alloc(46);
		dir.writeUInt32LE(0x02014b50, 0);
		dir.writeUInt16LE(20, 4);
		dir.writeUInt16LE(20, 6);
		dir.writeUInt32LE(crc, 16);
		dir.writeUInt32LE(data.length, 20);
		dir.writeUInt32LE(data.length, 24);
		dir.writeUInt16LE(n.length, 28);
		dir.writeUInt32LE(offset, 42);
		chunks.push(local, n, data);
		central.push(dir, n);
		offset += 30 + n.length + data.length;
	}
	const dirBuf = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(dirBuf.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...chunks, dirBuf, end]);
}

const slow = Number(process.env.FAKE_CLI_SLOW ?? 0);
if (slow) setTimeout(finish, slow);
else finish();
