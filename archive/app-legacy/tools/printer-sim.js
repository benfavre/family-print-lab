#!/usr/bin/env node
'use strict';
// Bambu Lab printer simulator for development: a local MQTT endpoint that behaves like a printer in
// LAN-only + Developer Mode (login "bblp" + access code, device/<serial>/report, "pushall" requests),
// playing out prints with heating, layers, AMS usage, finish/failure and alerts.
// Plain TCP only (point the app at it with BAMBU_TLS=off). Controlled from its web page or stdin.
const http = require('node:http');
const net = require('node:net');
const readline = require('node:readline');
const {encode, decode, TYPE} = require('../lib/mqtt');

const AMS_DEFAULT = [
  {type:'PLA', color:'2B2F36FF', name:'PLA Matte Charcoal', remain:58},
  {type:'PETG', color:'1FB8A6FF', name:'PETG Translucent Teal', remain:9},
  {type:'PLA', color:'FF7A2FFF', name:'PLA Basic Orange', remain:92},
  null,
];
const PLATES = {PLA:{nozzle:220, bed:55, chamber:0}, PETG:{nozzle:250, bed:70, chamber:0}, ABS:{nozzle:260, bed:90, chamber:50}, ASA:{nozzle:260, bed:90, chamber:50}, TPU:{nozzle:230, bed:35, chamber:0}};
const SAMPLE_TASKS = ['cable_dock_v03', 'pencil_rocket_v01', 'drawer_divider_A', 'phone_stand_v02', 'room_sign_daughter', 'adapter_tray_v01'];

function createSimulator({serial = 'SIM-X2D-0001', accessCode = '12345678', speed = 20, auto = false, failRate = 0.15, log = console.log} = {}) {
  const sockets = new Set();
  const sim = {
    speed, auto, failRate,
    state:{gcode_state:'IDLE', mc_percent:0, mc_remaining_time:0, layer_num:0, total_layer_num:0, nozzle_temper:26, nozzle_target_temper:0, bed_temper:25, bed_target_temper:0,
      chamber_temper:27, subtask_name:'', gcode_file:'', spd_lvl:2, print_error:0, hms:[], wifi_signal:'-48dBm',
      ams:{tray_now:'255', ams:[{id:'0', humidity:'3', temp:'26.1', tray:AMS_DEFAULT.map((t, i) => t ? {id:String(i), tray_type:t.type, tray_sub_brands:t.name, tray_color:t.color, remain:t.remain} : {id:String(i)})}]}},
    job:null, sent:{}, clock:null,
  };
  const s = sim.state, tray = () => s.ams.ams[0].tray[Number(s.ams.tray_now)];

  function publish(print, full = false) {
    const patch = full ? print : Object.fromEntries(Object.entries(print).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(sim.sent[k])));
    if (!Object.keys(patch).length) return;
    Object.assign(sim.sent, structuredClone(patch));
    const packet = encode.publish(`device/${serial}/report`, JSON.stringify({print:{...patch, command:'push_status', msg:full ? 0 : 1, sequence_id:String(Date.now() % 100000)}}));
    for (const socket of sockets) socket.write(packet);
  }
  const report = (full = false) => publish(structuredClone({...s, nozzle_temper:round(s.nozzle_temper), bed_temper:round(s.bed_temper), chamber_temper:round(s.chamber_temper), mc_percent:Math.floor(s.mc_percent), mc_remaining_time:Math.ceil(s.mc_remaining_time)}), full);
  const round = (n) => Math.round(n * 10) / 10;

  // One simulated second per call.
  function step() {
    const approach = (now, target, rate) => now + (Math.max(target, 25) - now) * rate;
    s.nozzle_temper = approach(s.nozzle_temper, s.nozzle_target_temper, 0.18);
    s.bed_temper = approach(s.bed_temper, s.bed_target_temper, 0.05);
    s.chamber_temper = approach(s.chamber_temper, Math.max(27, sim.job?.chamber || 0, s.bed_temper * 0.45), 0.01);
    if (!sim.job) return;
    const j = sim.job;
    if (s.gcode_state === 'PREPARE' && s.nozzle_temper > s.nozzle_target_temper - 3 && s.bed_temper > s.bed_target_temper - 3) { s.gcode_state = 'RUNNING'; log(`▶ printing "${j.name}"`); }
    if (s.gcode_state !== 'RUNNING') return;
    j.elapsed += 1;
    const progress = Math.min(1, j.elapsed / j.seconds);
    s.mc_percent = progress * 100;
    s.mc_remaining_time = Math.max(0, (j.seconds - j.elapsed) / 60);
    s.layer_num = Math.max(1, Math.ceil(progress * s.total_layer_num));
    const t = tray(); if (t?.remain > 0) t.remain = Math.max(0, Math.round(j.startRemain - progress * j.grams / 10));
    if (j.failAt && progress >= j.failAt) return fail(0x0300800A, 'Spaghetti / first-layer detachment (simulated)');
    if (progress >= 1) finish();
  }

  function start({name = SAMPLE_TASKS[Math.floor(Math.random() * SAMPLE_TASKS.length)], minutes = 45, slot = null, layers = null, grams = null} = {}) {
    if (['PREPARE', 'RUNNING', 'PAUSE'].includes(s.gcode_state)) throw new Error('A print is already running. Finish, fail or stop it first.');
    const trays = s.ams.ams[0].tray, index = slot !== null ? Number(slot) : trays.findIndex(t => t.tray_type);
    const t = trays[index]; if (!t?.tray_type) throw new Error(`AMS slot ${Number(slot) + 1} is empty.`);
    const temps = PLATES[t.tray_type] || PLATES.PLA;
    sim.job = {name, seconds:Math.max(60, Math.round(minutes * 60)), elapsed:0, grams:grams ?? Math.round(minutes * 1.1), startRemain:t.remain ?? 100, chamber:temps.chamber,
      failAt:Math.random() < sim.failRate ? 0.1 + Math.random() * 0.6 : 0};
    Object.assign(s, {gcode_state:'PREPARE', subtask_name:name, gcode_file:`/data/Metadata/${name}.gcode`, mc_percent:0, mc_remaining_time:minutes, layer_num:0,
      total_layer_num:layers ?? Math.max(20, Math.round(minutes * 3.2)), nozzle_target_temper:temps.nozzle, bed_target_temper:temps.bed, print_error:0});
    s.ams.tray_now = String(index);
    log(`● heating for "${name}" (${minutes} min, ${t.tray_type} in slot ${index + 1})${sim.job.failAt ? ' — this one will fail' : ''}`);
    report();
    return sim.job;
  }
  function settle(state) {
    s.gcode_state = state; s.nozzle_target_temper = 0; s.bed_target_temper = 0; s.mc_remaining_time = 0;
    s.ams.tray_now = '255'; sim.job = null; report();
    if (sim.auto) setTimeout(() => { if (!sim.job) try { start({minutes:20 + Math.round(Math.random() * 60)}); } catch {} }, 8000 / Math.max(1, sim.speed / 10));
  }
  function finish() { if (!sim.job) throw new Error('Nothing is printing.'); s.mc_percent = 100; s.layer_num = s.total_layer_num; log(`✓ finished "${s.subtask_name}"`); settle('FINISH'); }
  function fail(code = 0x0300800A, why = 'failed (simulated)') { if (!sim.job) throw new Error('Nothing is printing.'); s.print_error = code; log(`✕ "${s.subtask_name}": ${why}`); settle('FAILED'); }
  function pause() { if (s.gcode_state !== 'RUNNING') throw new Error('Only a running print can pause.'); s.gcode_state = 'PAUSE'; log('❚❚ paused'); report(); }
  function resume() { if (s.gcode_state !== 'PAUSE') throw new Error('Nothing is paused.'); s.gcode_state = 'RUNNING'; log('▶ resumed'); report(); }
  function stop() { if (!sim.job) throw new Error('Nothing is printing.'); log('■ stopped'); settle('IDLE'); }
  function toggleAlert() {
    s.hms = s.hms.length ? [] : [{attr:0x07000200, code:0x00020001}];
    log(s.hms.length ? '⚠ AMS alert raised (simulated)' : 'alert cleared'); report();
  }

  const broker = net.createServer(socket => {
    let buffer = Buffer.alloc(0), authed = false;
    socket.on('data', chunk => {
      let out;
      try { out = decode(Buffer.concat([buffer, chunk])); } catch { socket.destroy(); return; }
      buffer = out.rest;
      for (const p of out.packets) {
        if (p.type === TYPE.CONNECT) {
          if (p.username !== 'bblp' || p.password !== accessCode) { log('✕ rejected a connection with the wrong access code'); socket.write(encode.connack(5)); socket.end(); return; }
          authed = true; sockets.add(socket); socket.write(encode.connack(0)); log('⇄ app connected');
        }
        if (!authed) continue;
        if (p.type === TYPE.SUBSCRIBE) socket.write(encode.suback(p.id));
        if (p.type === TYPE.PINGREQ) socket.write(encode.pingresp());
        if (p.type === TYPE.PUBLISH && p.topic === `device/${serial}/request`) {
          let msg; try { msg = JSON.parse(p.payload.toString()); } catch { continue; }
          if (msg.pushing?.command === 'pushall') { sim.sent = {}; report(true); }
          else log(`(ignored command: ${JSON.stringify(msg).slice(0, 80)})`);
        }
        if (p.type === TYPE.DISCONNECT) socket.end();
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => { if (sockets.delete(socket)) log('⇄ app disconnected'); });
  });

  function tick() { for (let i = 0; i < sim.speed; i++) step(); report(); }

  return {
    sim, serial, accessCode, clients:() => sockets.size, start, finish, fail, pause, resume, stop, toggleAlert, step, report,
    setSpeed(n) { sim.speed = Math.max(1, Math.min(600, Number(n) || 1)); log(`speed ×${sim.speed}`); },
    listen(port = 1883, host = '127.0.0.1') { return new Promise(resolve => broker.listen(port, host, () => { sim.clock = setInterval(tick, 1000); resolve(broker.address().port); })); },
    close() { clearInterval(sim.clock); for (const socket of sockets) socket.destroy(); return new Promise(r => broker.close(() => r())); },
  };
}

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

function controlServer(sim) {
  return http.createServer((req, res) => {
    const send = (code, body, type = 'application/json') => { res.writeHead(code, {'Content-Type':type, 'Cache-Control':'no-store'}); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
    if (req.method === 'GET' && req.url === '/') return send(200, PAGE, 'text/html; charset=utf-8');
    if (req.method === 'GET' && req.url === '/api/state') return send(200, {state:sim.sim.state, speed:sim.sim.speed, auto:sim.sim.auto, clients:sim.clients(), serial:sim.serial, accessCode:sim.accessCode});
    if (req.method !== 'POST' || !req.url.startsWith('/api/')) return send(404, {error:'Not found'});
    let body = '';
    req.on('data', c => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      let input = {}; try { input = body ? JSON.parse(body) : {}; } catch { return send(400, {error:'Invalid JSON'}); }
      const actions = {start:() => sim.start({name:input.name, minutes:input.minutes, slot:input.slot === '' || input.slot === undefined ? null : input.slot}), pause:sim.pause, resume:sim.resume, finish:sim.finish,
        fail:() => sim.fail(), stop:sim.stop, alert:sim.toggleAlert, speed:() => sim.setSpeed(input.speed), auto:() => { sim.sim.auto = !!input.auto; }};
      const action = actions[req.url.slice(5)];
      if (!action) return send(404, {error:'Unknown command'});
      try { action(); send(200, {ok:true}); } catch (error) { send(409, {error:error.message}); }
    });
  });
}

if (require.main === module) {
  const args = process.argv.slice(2), opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
  if (args.includes('--help')) {
    console.log(`Usage: node app/tools/printer-sim.js [--port 1883] [--control 8766] [--serial SIM-X2D-0001] [--code 12345678] [--speed 20] [--auto] [--fail-rate 0.15]
Commands on stdin: start [name] [minutes] [slot 1-4] · pause · resume · finish · fail · stop · alert · speed N · auto on|off · status`);
    process.exit(0);
  }
  const stamp = () => new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'});
  const sim = createSimulator({serial:opt('serial', 'SIM-X2D-0001'), accessCode:opt('code', '12345678'), speed:Number(opt('speed', 20)), auto:args.includes('--auto'), failRate:Number(opt('fail-rate', 0.15)), log:(m) => console.log(`[sim ${stamp()}] ${m}`)});
  (async () => {
    const port = await sim.listen(Number(opt('port', 1883)));
    const control = controlServer(sim), controlPort = Number(opt('control', 8766));
    control.listen(controlPort, '127.0.0.1');
    console.log(`[sim] Bambu printer simulator on 127.0.0.1:${port} · serial ${sim.serial} · access code ${sim.accessCode} · speed ×${sim.sim.speed}`);
    console.log(`[sim] Control page: http://127.0.0.1:${controlPort}  (or type "help")`);
    const rl = readline.createInterface({input:process.stdin});
    rl.on('line', line => {
      const [command, ...rest] = line.trim().split(/\s+/);
      try {
        if (command === 'start') sim.start({name:rest[0], minutes:Number(rest[1] || 45), slot:rest[2] ? Number(rest[2]) - 1 : null});
        else if (['pause', 'resume', 'finish', 'fail', 'stop'].includes(command)) sim[command]();
        else if (command === 'alert') sim.toggleAlert();
        else if (command === 'speed') sim.setSpeed(rest[0]);
        else if (command === 'auto') { sim.sim.auto = rest[0] !== 'off'; console.log(`[sim] auto-play ${sim.sim.auto ? 'on' : 'off'}`); }
        else if (command === 'status') console.log(JSON.stringify({state:sim.sim.state.gcode_state, task:sim.sim.state.subtask_name, percent:Math.floor(sim.sim.state.mc_percent)}));
        else if (command) console.log('[sim] commands: start [name] [minutes] [slot] · pause · resume · finish · fail · stop · alert · speed N · auto on|off · status');
      } catch (error) { console.log(`[sim] ${error.message}`); }
    });
    process.on('SIGINT', async () => { await sim.close(); control.close(); process.exit(0); });
  })();
}

module.exports = {createSimulator};
