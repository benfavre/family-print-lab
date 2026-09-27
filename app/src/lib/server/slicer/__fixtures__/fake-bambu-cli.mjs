// A fake Bambu Studio command line for cli.test.ts and the service tests: takes the options
// CliEngine passes (see cli.ts), checks the preset files the way BambuStudio.cpp load_config_file does
// (name, from, type), and writes what the real one writes: out/result.json (record_exit_reson) and a
// 3MF with one build item per input (bbs_3mf.cpp), sliced with a plate G-code when --slice is given.
// Like the real CLI it leaves printer_model_id blank and writes no plate picture.
//   FAKE_CLI_LOG   append one JSON line per run: { args, machine, process, filaments }
//   FAKE_CLI_FAIL  1: answer with return_code -50 and an error string
//   FAKE_CLI_SLOW  milliseconds to wait before finishing (cancel tests)
// Orient turns every object 90° about X; arrange moves object i to (60 + 70·i, 100, 0).
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

if (process.env.FAKE_CLI_LOG)
	fs.appendFileSync(
		process.env.FAKE_CLI_LOG,
		`${JSON.stringify({ args: argv, machine, process: proc, filaments })}\n`
	);

const finish = () => {
	if (process.env.FAKE_CLI_FAIL === '1') {
		result(-50, 'Nothing to be sliced, either the print is empty or no object is fully inside the plate boundary.');
		process.exit(1);
	}
	// Mesh heights from the binary STLs (for a layer count).
	let top = 0;
	for (const input of inputs) {
		const b = fs.readFileSync(input);
		const n = b.readUInt32LE(80);
		for (let t = 0; t < n; t++)
			for (let v = 0; v < 3; v++) top = Math.max(top, b.readFloatLE(84 + t * 50 + 12 + v * 12 + 8));
	}
	const items = inputs.map((_, i) => {
		let t = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
		if (opts.orient === '1') t = [1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 0, 0];
		if (opts.arrange === '1') t = [...t.slice(0, 9), 60 + 70 * i, 100, 0];
		return t;
	});
	const entries = [
		['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types/>'],
		[
			'3D/3dmodel.model',
			`<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter">\n <build>\n${items
				.map((t, i) => `  <item objectid="${i + 2}" transform="${t.join(' ')}" printable="1"/>`)
				.join('\n')}\n </build>\n</model>\n`
		]
	];
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
