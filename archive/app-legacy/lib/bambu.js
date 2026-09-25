'use strict';
// Read-only link to a Bambu Lab printer in LAN-only + Developer Mode, over its local MQTT broker.
// Field names follow the community-documented report format (X1/P1/A1); newer models may add or rename
// fields, so every value is optional and unknown data is ignored rather than trusted.
const {EventEmitter} = require('node:events');
const {MqttClient} = require('./mqtt');

const ACTIVE = new Set(['PREPARE', 'RUNNING', 'PAUSE', 'SLICING']);
const num = (v) => { const n = typeof v === 'string' ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) ? n : null; };
const text = (v, max = 200) => typeof v === 'string' ? v.slice(0, max) : '';

function merge(target, patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) merge(target[key], value);
    else target[key] = value;
  }
  return target;
}

function color(hex) { return typeof hex === 'string' && /^[0-9a-f]{6}/i.test(hex) ? `#${hex.slice(0, 6).toLowerCase()}` : null; }

// Turns the raw, incrementally-updated `print` report into the snapshot the app uses.
function summarize(p = {}) {
  const units = Array.isArray(p.ams?.ams) ? p.ams.ams : [];
  const trayNow = text(p.ams?.tray_now, 8);
  return {
    gcodeState: text(p.gcode_state, 20) || 'UNKNOWN',
    percent: num(p.mc_percent),
    remainingMinutes: num(p.mc_remaining_time),
    layer: num(p.layer_num),
    totalLayers: num(p.total_layer_num),
    nozzle: num(p.nozzle_temper), nozzleTarget: num(p.nozzle_target_temper),
    bed: num(p.bed_temper), bedTarget: num(p.bed_target_temper),
    chamber: num(p.chamber_temper),
    task: text(p.subtask_name) || text(p.gcode_file),
    speedLevel: num(p.spd_lvl),
    printError: num(p.print_error) || 0,
    hms: Array.isArray(p.hms) ? p.hms.slice(0, 20).map(h => ({attr:num(h.attr), code:num(h.code)})) : [],
    wifiSignal: text(p.wifi_signal, 20),
    ams: units.slice(0, 8).map(unit => ({
      unit: text(String(unit.id ?? ''), 8),
      humidity: num(unit.humidity),
      trays: (Array.isArray(unit.tray) ? unit.tray : []).slice(0, 4).map(tray => ({
        slot: text(String(tray.id ?? ''), 8),
        active: trayNow !== '' && Number(trayNow) === Number(unit.id) * 4 + Number(tray.id),
        type: text(tray.tray_type, 40),
        name: text(tray.tray_sub_brands, 80),
        color: color(tray.tray_color),
        remain: num(tray.remain) !== null && tray.remain >= 0 ? tray.remain : null,
      })),
    })),
  };
}

class BambuPrinter extends EventEmitter {
  constructor({host, serial, accessCode, name = 'Bambu Lab printer', port = 8883, useTls = true, simulated = false}) {
    super();
    Object.assign(this, {host, serial, accessCode, name, port, useTls, simulated});
    this.raw = {}; this.snapshot = null; this.connected = false; this.lastSeen = null; this.error = ''; this.warning = '';
    this.retry = 0; this.stopped = false; this.lastTask = ''; this.lastState = '';
  }

  start() { this.stopped = false; this.open(); return this; }

  open() {
    const client = new MqttClient({host:this.host, port:this.port, useTls:this.useTls, clientId:`print-lab-${process.pid}`, username:'bblp', password:this.accessCode,
      // The printer presents a self-signed certificate; we check it names this printer's serial instead.
      tlsOptions:{rejectUnauthorized:false, checkServerIdentity:() => undefined}});
    this.client = client;
    client.on('connect', () => {
      if (this.useTls) {
        const cn = client.socket.getPeerCertificate?.()?.subject?.CN;
        this.warning = cn && cn !== this.serial ? `Printer certificate names “${cn}”, not the configured serial.` : '';
      }
      this.connected = true; this.error = ''; this.retry = 0;
      client.subscribe(`device/${this.serial}/report`);
      this.requestFull();
      this.emit('update');
    });
    client.on('message', (topic, payload) => this.receive(payload));
    client.on('error', (error) => { this.error = friendly(error); });
    client.on('close', () => {
      this.connected = false; this.emit('update');
      if (this.stopped) return;
      const delay = Math.min(60000, 2000 * 2 ** this.retry++);
      this.timer = setTimeout(() => this.open(), delay);
    });
    client.connect();
  }

  requestFull() { this.client?.publish(`device/${this.serial}/request`, {pushing:{sequence_id:'0', command:'pushall'}}); }

  receive(payload) {
    let message;
    try { message = JSON.parse(payload.toString('utf8')); } catch { return; }
    if (!message || typeof message.print !== 'object') return;
    merge(this.raw, message.print);
    this.snapshot = summarize(this.raw);
    this.lastSeen = new Date().toISOString();
    const {gcodeState:state, task} = this.snapshot;
    if (state !== this.lastState) {
      const from = this.lastState;
      this.lastState = state;
      if (ACTIVE.has(state) && !ACTIVE.has(from)) this.emit('started', {task});
      if ((state === 'FINISH' || state === 'FAILED') && ACTIVE.has(from)) this.emit('finished', {task:this.lastTask || task, ok:state === 'FINISH'});
    }
    if (task) this.lastTask = task;
    this.emit('update');
  }

  status() {
    return {configured:true, name:this.name, simulated:this.simulated, connected:this.connected, lastSeen:this.lastSeen, error:this.connected ? '' : this.error, warning:this.warning,
      printing:!!this.snapshot && ACTIVE.has(this.snapshot.gcodeState), state:this.snapshot};
  }

  stop() { this.stopped = true; clearTimeout(this.timer); this.client?.end(); }
}

function friendly(error) {
  if (error.code === 'ECONNREFUSED') return 'Printer refused the connection. Check that LAN-only mode and Developer Mode are on.';
  if (error.code === 'EHOSTUNREACH' || error.code === 'ETIMEDOUT' || error.code === 'ENETUNREACH') return 'Printer not reachable. Check its IP address and that it is on the same network.';
  return error.message || 'Printer connection failed.';
}

function fromEnv(env = process.env) {
  const {BAMBU_HOST:host, BAMBU_SERIAL:serial, BAMBU_ACCESS_CODE:accessCode} = env;
  if (!host || !serial || !accessCode) return null;
  return new BambuPrinter({host, serial, accessCode, name:env.BAMBU_NAME || 'Bambu Lab X2D', port:Number(env.BAMBU_PORT || 8883), useTls:env.BAMBU_TLS !== 'off', simulated:env.BAMBU_SIMULATED === '1'});
}

module.exports = {BambuPrinter, summarize, fromEnv, ACTIVE};
