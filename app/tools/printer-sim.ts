// CLI and control page for the printer simulator (see src/lib/server/printer/simulator.ts).
import http from 'node:http';
import readline from 'node:readline';
import { createSimulator, type Simulator } from '../src/lib/server/printer/simulator';

// ---------- Control page ----------
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Printer simulator</title>
<style>:root{color-scheme:dark;font:14px/1.5 system-ui,sans-serif;background:#0b0e14;color:#e9f1ff}body{max-width:720px;margin:32px auto;padding:0 16px}h1{font-size:20px;margin:0}
p{color:#8d9cb6;margin:4px 0 20px}.card{border:1px solid #ffffff17;border-radius:10px;padding:14px 16px;margin-bottom:12px;background:#10131b}.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
button,input,select{font:inherit;color:inherit;background:#ffffff0d;border:1px solid #ffffff26;border-radius:8px;padding:6px 11px}button{cursor:pointer}button.go{background:#5ee7ff;color:#04121a;border:0}input{width:190px}
pre{margin:0;font:12px/1.5 ui-monospace,monospace;color:#c6d3e8;white-space:pre-wrap}.state{font-size:18px;font-weight:600}.bar{height:6px;background:#ffffff12;border-radius:6px;overflow:hidden;margin:8px 0}.bar i{display:block;height:100%;background:#b8ff5e}</style></head>
<body><h1>Bambu printer simulator</h1><p>Fake printer for development. The Family Print Lab app reads it exactly like a real printer on the network.</p>
<p id="msg" style="color:#ff6b7a;min-height:1.5em;margin:0 0 8px"></p><div class="card"><div class="state" id="state">…</div><div class="bar"><i id="bar"></i></div><pre id="info"></pre></div>
<div class="card row"><input id="name" placeholder="Task name (optional)"><input id="minutes" type="number" min="1" value="45" style="width:90px"> min
<select id="slot"></select><button class="go" data-cmd="start">Start print</button></div>
<div class="card row"><button data-cmd="pause">Pause</button><button data-cmd="resume">Resume</button><button data-cmd="finish">Finish now</button><button data-cmd="fail">Fail now</button><button data-cmd="stop">Stop</button><button data-cmd="alert">Toggle alert</button>
<label>Speed <select id="speed"><option>1</option><option>5</option><option selected>20</option><option>60</option><option>300</option></select>×</label><label><input type="checkbox" id="auto" style="width:auto"> Auto-play</label></div>
<script>
const $ = s => document.querySelector(s);
async function cmd(name, body = {}) { const r = await fetch('/api/' + name, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)}); const d = await r.json(); $('#msg').textContent = r.ok ? '' : d.error; refresh(); }
document.addEventListener('click', e => { const b = e.target.closest('[data-cmd]'); if (!b) return; const c = b.dataset.cmd; cmd(c, c === 'start' ? {name:$('#name').value || undefined, minutes:Number($('#minutes').value), slot:$('#slot').value} : {}); });
$('#speed').onchange = e => cmd('speed', {speed:Number(e.target.value)}); $('#auto').onchange = e => cmd('auto', {auto:e.target.checked});
async function refresh() {
  const d = await (await fetch('/api/state')).json(), s = d.state;
  $('#state').textContent = s.gcode_state + (s.subtask_name ? ' — ' + s.subtask_name : '');
  $('#bar').style.width = s.mc_percent + '%';
  $('#info').textContent = 'progress ' + Math.floor(s.mc_percent) + '%  layer ' + s.layer_num + '/' + s.total_layer_num + '  left ' + Math.ceil(s.mc_remaining_time) + ' min\\nnozzle ' + s.nozzle_temper.toFixed(0) + '/' + s.nozzle_target_temper + '°  bed ' + s.bed_temper.toFixed(0) + '/' + s.bed_target_temper + '°  chamber ' + s.chamber_temper.toFixed(0) + '°\\n' +
    s.ams.ams[0].tray.map((t, i) => 'slot ' + (i + 1) + ': ' + (t.tray_type ? t.tray_type + ' #' + t.tray_color.slice(0, 6) + ' ' + t.remain + '%' : 'empty') + (s.ams.tray_now === String(i) ? '  ← loaded' : '')).join('\\n') +
    (s.hms.length ? '\\nalert raised' : '') + '\\nconnected apps: ' + d.clients + '  serial ' + d.serial + '  access code ' + d.accessCode;
  if (!$('#slot').options.length) $('#slot').innerHTML = s.ams.ams[0].tray.map((t, i) => t.tray_type ? '<option value="' + i + '">Slot ' + (i + 1) + ' · ' + t.tray_type + '</option>' : '').join('');
  $('#speed').value = String(d.speed); $('#auto').checked = d.auto;
}
refresh(); setInterval(refresh, 1000);
</script></body></html>`;

function controlServer(sim: Simulator) {
	return http.createServer((req, res) => {
		const send = (code: number, body: unknown, type = 'application/json') => {
			res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
			res.end(type === 'application/json' ? JSON.stringify(body) : (body as string));
		};
		if (req.method === 'GET' && req.url === '/') return send(200, PAGE, 'text/html; charset=utf-8');
		if (req.method === 'GET' && req.url === '/api/state')
			return send(200, {
				state: sim.sim.state,
				speed: sim.sim.speed,
				auto: sim.sim.auto,
				clients: sim.clients(),
				serial: sim.serial,
				accessCode: sim.accessCode
			});
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
		console.log(`Usage: npm run sim -- [--port 1883] [--control 8766] [--serial SIM-X2D-0001] [--code 12345678] [--speed 20] [--auto] [--fail-rate 0.15]
Commands on stdin: start [name] [minutes] [slot 1-4] · pause · resume · finish · fail · stop · alert · speed N · auto on|off · status`);
		process.exit(0);
	}
	const stamp = () =>
		new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	const sim = createSimulator({
		serial: opt('serial', 'SIM-X2D-0001'),
		accessCode: opt('code', '12345678'),
		speed: Number(opt('speed', 20)),
		auto: args.includes('--auto'),
		failRate: Number(opt('fail-rate', 0.15)),
		log: (m: string) => console.log(`[sim ${stamp()}] ${m}`)
	});
	(async () => {
		const port = await sim.listen(Number(opt('port', 1883)));
		const control = controlServer(sim),
			controlPort = Number(opt('control', 8766));
		control.listen(controlPort, '127.0.0.1');
		console.log(
			`[sim] Bambu printer simulator on 127.0.0.1:${port} · serial ${sim.serial} · access code ${sim.accessCode} · speed ×${sim.sim.speed}`
		);
		console.log(`[sim] Control page: http://127.0.0.1:${controlPort}  (or type "help")`);
		const rl = readline.createInterface({ input: process.stdin });
		rl.on('line', (line) => {
			const [command, ...rest] = line.trim().split(/\s+/);
			try {
				if (command === 'start')
					sim.start({
						name: rest[0],
						minutes: Number(rest[1] || 45),
						slot: rest[2] ? Number(rest[2]) - 1 : null
					});
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
							state: sim.sim.state.gcode_state,
							task: sim.sim.state.subtask_name,
							percent: Math.floor(sim.sim.state.mc_percent)
						})
					);
				else if (command)
					console.log(
						'[sim] commands: start [name] [minutes] [slot] · pause · resume · finish · fail · stop · alert · speed N · auto on|off · status'
					);
			} catch (error) {
				console.log(`[sim] ${(error as Error).message}`);
			}
		});
		process.on('SIGINT', async () => {
			await sim.close();
			control.close();
			process.exit(0);
		});
	})();
}
