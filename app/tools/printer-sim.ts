// CLI and control page for the printer simulator (see src/lib/server/printer/sim/). One printer by
// default (an X2D, as before), or a fleet: --fleet N6,C12,N1. MQTT ports count up from --port, file
// service ports from --ftp-port; --ssdp <port> makes the printers announce themselves for discovery.
import http from 'node:http';
import readline from 'node:readline';
import { createFleet, type Fleet } from '../src/lib/server/printer/sim/fleet';
import { attachPlug, createFakePlug } from '../src/lib/server/printer/sim/features/power';
import { MODEL_CODES, isModelCode, type ModelCode } from '../src/lib/shared/printers/models';

// ---------- Control page ----------
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Printer simulator</title>
<style>:root{color-scheme:dark;font:14px/1.5 system-ui,sans-serif;background:#0b0e14;color:#e9f1ff}body{max-width:760px;margin:32px auto;padding:0 16px}h1{font-size:20px;margin:0}
p{color:#8d9cb6;margin:4px 0 20px}.card{border:1px solid #ffffff17;border-radius:10px;padding:14px 16px;margin-bottom:12px;background:#10131b}.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
button,input,select{font:inherit;color:inherit;background:#ffffff0d;border:1px solid #ffffff26;border-radius:8px;padding:6px 11px}button{cursor:pointer}button.go{background:#5ee7ff;color:#04121a;border:0}input{width:190px}
button[aria-pressed=true]{background:#5ee7ff26;border-color:#5ee7ff}pre{margin:0;font:12px/1.5 ui-monospace,monospace;color:#c6d3e8;white-space:pre-wrap}.state{font-size:18px;font-weight:600}.bar{height:6px;background:#ffffff12;border-radius:6px;overflow:hidden;margin:8px 0}.bar i{display:block;height:100%;background:#b8ff5e}</style></head>
<body><h1>Bambu printer simulator</h1><p>Fake printers for development. The Family Print Lab app reads them exactly like real printers on the network.</p>
<div class="row card" id="printers" role="tablist" aria-label="Printer"></div>
<p id="msg" style="color:#ff6b7a;min-height:1.5em;margin:0 0 8px"></p><div class="card"><div class="state" id="state">…</div><div class="bar"><i id="bar"></i></div><pre id="info"></pre></div>
<div class="card row"><input id="name" placeholder="Task name (optional)"><input id="minutes" type="number" min="1" value="45" style="width:90px"> min
<select id="slot"></select><button class="go" data-cmd="start">Start print</button></div>
<div class="card row"><button data-cmd="pause">Pause</button><button data-cmd="resume">Resume</button><button data-cmd="finish">Finish now</button><button data-cmd="fail">Fail now</button><button data-cmd="stop">Stop</button><button data-cmd="alert">Toggle alert</button>
<label>Speed <select id="speed"><option>1</option><option>5</option><option selected>20</option><option>60</option><option>300</option></select>×</label><label><input type="checkbox" id="auto" style="width:auto"> Auto-play</label></div>
<div class="card row" id="features" hidden></div>
<script>
const $ = s => document.querySelector(s);
let current = 0, slotsFor = -1;
async function cmd(name, body = {}) { const r = await fetch('/api/' + name, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...body, printer: current})}); const d = await r.json(); $('#msg').textContent = r.ok ? '' : d.error; refresh(); }
document.addEventListener('click', e => {
  const p = e.target.closest('[data-printer]'); if (p) { current = Number(p.dataset.printer); slotsFor = -1; return refresh(); }
  const f = e.target.closest('[data-feature]'); if (f) return cmd('feature', {feature: f.dataset.feature, control: f.dataset.control});
  const b = e.target.closest('[data-cmd]'); if (!b) return; const c = b.dataset.cmd; cmd(c, c === 'start' ? {name:$('#name').value || undefined, minutes:Number($('#minutes').value), slot:$('#slot').value} : {}); });
$('#speed').onchange = e => cmd('speed', {speed:Number(e.target.value)}); $('#auto').onchange = e => cmd('auto', {auto:e.target.checked});
async function refresh() {
  const all = await (await fetch('/api/state')).json(), d = all.printers[current], s = d.state;
  $('#printers').innerHTML = all.printers.map((p, i) => '<button role="tab" data-printer="' + i + '" aria-pressed="' + (i === current) + '">' + p.name + ' · ' + p.state.gcode_state + '</button>').join('');
  $('#state').textContent = s.gcode_state + (s.subtask_name ? ' — ' + s.subtask_name : '');
  $('#bar').style.width = s.mc_percent + '%';
  $('#info').textContent = 'progress ' + Math.floor(s.mc_percent) + '%  layer ' + s.layer_num + '/' + s.total_layer_num + '  left ' + Math.ceil(s.mc_remaining_time) + ' min\\nnozzle ' + d.temps.nozzle.toFixed(0) + '/' + d.temps.nozzleTarget + '°  bed ' + d.temps.bed.toFixed(0) + '/' + d.temps.bedTarget + '°  chamber ' + d.temps.chamber.toFixed(0) + '°\\n' +
    d.trays.map(t => 'tray ' + t.label + ': ' + (t.type ? t.type + ' #' + t.color + (t.remain >= 0 ? ' ' + t.remain + '%' : '') : 'empty') + (t.active ? '  ← loaded' : '')).join('\\n') +
    (s.hms && s.hms.length ? '\\nalert raised' : '') + '\\nconnected apps: ' + d.clients + '  model ' + d.model + '  serial ' + d.serial + '  access code ' + d.accessCode + '  MQTT :' + d.port + '  files :' + d.ftpPort;
  if (slotsFor !== current) { slotsFor = current; $('#slot').innerHTML = d.trays.filter(t => t.type).map(t => '<option value="' + t.global + '">Tray ' + t.label + ' · ' + t.type + '</option>').join(''); }
  $('#features').hidden = !d.features.length;
  $('#features').innerHTML = d.features.map(f => '<button data-feature="' + f.feature + '" data-control="' + f.id + '">' + f.label + '</button>').join('');
  $('#speed').value = String(d.speed); $('#auto').checked = d.auto;
}
refresh(); setInterval(refresh, 1000);
</script></body></html>`;

const label = (g: number) =>
	g === 255
		? 'Ext'
		: g === 254
			? 'Ext 2'
			: g >= 128
				? `HT${g - 127}`
				: g >= 24 && g <= 27
					? `A${g - 23}`
					: `${String.fromCharCode(65 + (g >> 2))}${(g & 3) + 1}`;

function controlServer(fleet: Fleet) {
	const describe = (i: number) => {
		const { sim, port, ftpPort } = fleet.printers[i];
		const p = sim.sim;
		const activeTray = p.trays().find((t) => {
			const now = p.state.ams?.tray_now;
			return now !== undefined && now !== '255' && Number(now) === t.global;
		});
		return {
			name: p.name,
			model: sim.model.code,
			serial: sim.serial,
			accessCode: sim.accessCode,
			port,
			ftpPort,
			state: p.state,
			speed: p.speed,
			auto: p.auto,
			clients: sim.clients(),
			temps: p.temps(),
			trays: p.trays().map((t) => ({
				global: t.global,
				label: label(t.global),
				type: t.tray.tray_type ?? '',
				color: String(t.tray.tray_color ?? '').slice(0, 6),
				remain: Number(t.tray.remain ?? -1),
				active: t === activeTray || (p.job?.tray ?? null) === t.global
			})),
			features: sim.features.flatMap((f) =>
				(f.controls ?? []).map((c) => ({ feature: f.key, id: c.id, label: c.label }))
			)
		};
	};
	return http.createServer((req, res) => {
		const send = (code: number, body: unknown, type = 'application/json') => {
			res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
			res.end(type === 'application/json' ? JSON.stringify(body) : (body as string));
		};
		if (req.method === 'GET' && req.url === '/') return send(200, PAGE, 'text/html; charset=utf-8');
		if (req.method === 'GET' && req.url === '/api/state')
			return send(200, { printers: fleet.printers.map((_, i) => describe(i)) });
		if (req.method !== 'POST' || !req.url?.startsWith('/api/'))
			return send(404, { error: 'Not found' });
		let body = '';
		req.on('data', (c) => {
			body += c;
			if (body.length > 10000) req.destroy();
		});
		req.on('end', () => {
			let input: Record<string, unknown> = {};
			try {
				input = body ? JSON.parse(body) : {};
			} catch {
				return send(400, { error: 'Invalid JSON' });
			}
			const entry = fleet.printers[Number(input.printer ?? 0)];
			if (!entry) return send(404, { error: 'Unknown printer' });
			const sim = entry.sim;
			const actions: Record<string, () => unknown> = {
				start: () =>
					sim.start({
						name: input.name as string | undefined,
						minutes: Number(input.minutes ?? 45),
						slot: input.slot === '' || input.slot === undefined ? null : (input.slot as string)
					}),
				pause: sim.pause,
				resume: sim.resume,
				finish: sim.finish,
				fail: () => sim.fail(),
				stop: sim.stop,
				alert: sim.toggleAlert,
				speed: () => sim.setSpeed(input.speed),
				auto: () => {
					sim.sim.auto = !!input.auto;
				},
				feature: () => {
					const control = sim.features
						.find((f) => f.key === input.feature)
						?.controls?.find((c) => c.id === input.control);
					if (!control) throw new Error('Unknown control');
					control.run(sim.sim, input);
				}
			};
			const action = actions[req.url!.slice(5)];
			if (!action) return send(404, { error: 'Unknown command' });
			try {
				action();
				send(200, { ok: true });
			} catch (error) {
				send(409, { error: (error as Error).message });
			}
		});
	});
}

{
	const args = process.argv.slice(2),
		opt = (name: string, fallback: string) => {
			const i = args.indexOf(`--${name}`);
			return i >= 0 ? args[i + 1] : fallback;
		};
	if (args.includes('--help')) {
		console.log(`Usage: bun run sim -- [--fleet N6,C12,N1] [--port 1883] [--ftp-port 8990] [--control 8766] [--ssdp 2021] [--serial SIM-X2D-0001] [--code 12345678] [--speed 20] [--auto] [--fail-rate 0.15] [--plugs 8300]
Models: ${MODEL_CODES.join(', ')}
Commands on stdin act on the first printer (or "use N" to pick another): start [name] [minutes] [tray] · pause · resume · finish · fail · stop · alert · speed N · auto on|off · status · use N`);
		process.exit(0);
	}
	const stamp = () =>
		new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	const models = opt('fleet', 'N6')
		.split(',')
		.map((m) => m.trim())
		.filter(Boolean);
	for (const m of models)
		if (!isModelCode(m)) {
			console.error(`[sim] Unknown model ${m}. Models: ${MODEL_CODES.join(', ')}`);
			process.exit(1);
		}
	(async () => {
		const fleet = await createFleet({
			printers: models.map((model, i) => ({
				model: model as ModelCode,
				// --serial names the first printer (the single-printer command line keeps working).
				serial: i === 0 && args.includes('--serial') ? opt('serial', '') : undefined,
				accessCode: opt('code', '12345678'),
				speed: Number(opt('speed', '20')),
				auto: args.includes('--auto'),
				failRate: Number(opt('fail-rate', '0.15')),
				log: (m: string) =>
					console.log(`[sim ${stamp()}${models.length > 1 ? ` ${model}` : ''}] ${m}`)
			})),
			basePort: Number(opt('port', '1883')),
			baseFtpPort: Number(opt('ftp-port', '8990')),
			ssdpPort: args.includes('--ssdp') ? Number(opt('ssdp', '2021')) : undefined
		});
		const control = controlServer(fleet),
			controlPort = Number(opt('control', '8766'));
		control.listen(controlPort, '127.0.0.1');
		for (const p of fleet.printers)
			console.log(
				`[sim] ${p.sim.model.name} on 127.0.0.1:${p.port} · serial ${p.sim.serial} · access code ${p.sim.accessCode} · files on :${p.ftpPort} · speed ×${p.sim.sim.speed}`
			);
		// --plugs <port>: each printer on a fake smart plug (sim/features/power.ts) at port, port+1…
		if (args.includes('--plugs')) {
			const base = Number(opt('plugs', '8300'));
			for (const [i, p] of fleet.printers.entries()) {
				const plug = attachPlug(p.sim, { bootMs: 3000 });
				// A busy port only costs the fake plug, never the simulator.
				try {
					await createFakePlug({ plug, port: base + i });
				} catch (error) {
					console.log(`[sim] No fake plug on :${base + i}: ${(error as Error).message}`);
					continue;
				}
				console.log(
					`[sim] ${p.sim.sim.name} is on a fake smart plug at http://127.0.0.1:${base + i} (Tasmota, Shelly, Home Assistant or webhooks /on and /off)`
				);
			}
		}
		console.log(`[sim] Control page: http://127.0.0.1:${controlPort}  (or type "help")`);
		let current = 0;
		const rl = readline.createInterface({ input: process.stdin });
		rl.on('line', (line) => {
			const [command, ...rest] = line.trim().split(/\s+/);
			const sim = fleet.printers[current].sim;
			try {
				if (command === 'use') {
					const n = Number(rest[0]);
					if (!fleet.printers[n])
						throw new Error(
							`There are ${fleet.printers.length} printers (0–${fleet.printers.length - 1}).`
						);
					current = n;
					console.log(`[sim] now controlling ${fleet.printers[n].sim.sim.name}`);
				} else if (command === 'start')
					sim.start({ name: rest[0], minutes: Number(rest[1] || 45), slot: rest[2] ?? null });
				else if (
					command === 'pause' ||
					command === 'resume' ||
					command === 'finish' ||
					command === 'fail' ||
					command === 'stop'
				)
					sim[command]();
				else if (command === 'alert') sim.toggleAlert();
				else if (command === 'speed') sim.setSpeed(rest[0]);
				else if (command === 'auto') {
					sim.sim.auto = rest[0] !== 'off';
					console.log(`[sim] auto-play ${sim.sim.auto ? 'on' : 'off'}`);
				} else if (command === 'status')
					console.log(
						JSON.stringify({
							printer: sim.sim.name,
							state: sim.sim.state.gcode_state,
							task: sim.sim.state.subtask_name,
							percent: Math.floor(sim.sim.state.mc_percent)
						})
					);
				else if (command)
					console.log(
						'[sim] commands: start [name] [minutes] [tray] · pause · resume · finish · fail · stop · alert · speed N · auto on|off · status · use N'
					);
			} catch (error) {
				console.log(`[sim] ${(error as Error).message}`);
			}
		});
		process.on('SIGINT', async () => {
			await fleet.close();
			control.close();
			process.exit(0);
		});
	})();
}
