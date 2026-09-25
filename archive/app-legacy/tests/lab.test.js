'use strict';
// Printer link (against a fake MQTT printer) and AI assistant (against a stub client). No network access.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {encode, decode, TYPE} = require('../lib/mqtt');
const {BambuPrinter, summarize} = require('../lib/bambu');
const {createAi, snapshot} = require('../lib/ai');
const {makeServer, migrate} = require('../server.js');

const SERIAL = '0309CA000000001';
const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function until(check, ms = 3000) { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return; await wait(20); } assert.fail('Timed out waiting for condition'); }

// A fake printer: accepts one access code, answers pushall, and lets the test push reports.
function fakePrinter(code = '12345678') {
  const sockets = new Set(), seen = [];
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      const out = decode(Buffer.concat([buffer, chunk])); buffer = out.rest;
      for (const p of out.packets) {
        seen.push(p);
        if (p.type === TYPE.CONNECT) {
          if (p.username !== 'bblp' || p.password !== code) { socket.write(encode.connack(5)); socket.end(); return; }
          sockets.add(socket); socket.write(encode.connack(0));
        }
        if (p.type === TYPE.SUBSCRIBE) socket.write(encode.suback(p.id));
        if (p.type === TYPE.PINGREQ) socket.write(encode.pingresp());
        if (p.type === TYPE.PUBLISH && p.topic === `device/${SERIAL}/request`) server.report({gcode_state:'IDLE', nozzle_temper:25, bed_temper:24, ams:{tray_now:'1', ams:[{id:'0', humidity:'4', tray:[{id:'0', tray_type:'PLA', tray_color:'FF7A2FFF', remain:80}, {id:'1', tray_type:'PETG', tray_color:'1FB8A6FF', remain:35}]}]}});
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  server.report = (print) => { for (const s of sockets) s.write(encode.publish(`device/${SERIAL}/report`, JSON.stringify({print}))); };
  server.seen = seen;
  server.closeAll = () => new Promise(r => { for (const s of sockets) s.destroy(); server.close(r); });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('MQTT packets survive encoding and arbitrary chunking', () => {
  const bytes = Buffer.concat([encode.connect({clientId:'c', username:'bblp', password:'pw'}), encode.publish('t/x', 'y'.repeat(300)), encode.subscribe(7, 'a/b')]);
  for (const cut of [1, 2, 5, 40, 200, bytes.length - 1]) {
    const first = decode(bytes.subarray(0, cut)), second = decode(Buffer.concat([first.rest, bytes.subarray(cut)]));
    const packets = [...first.packets, ...second.packets];
    assert.deepEqual(packets.map(p => p.type), [TYPE.CONNECT, TYPE.PUBLISH, TYPE.SUBSCRIBE]);
    assert.equal(packets[0].password, 'pw');
    assert.equal(packets[1].payload.toString(), 'y'.repeat(300));
    assert.equal(packets[2].topic, 'a/b');
  }
});

test('printer reports become a clean snapshot', () => {
  const s = summarize({gcode_state:'RUNNING', mc_percent:42, mc_remaining_time:31, layer_num:'80', total_layer_num:200, subtask_name:'cable_dock_v2', nozzle_temper:219.8, ams:{tray_now:'5', ams:[{id:'1', tray:[{id:'1', tray_type:'PETG', tray_color:'00AE42FF', remain:-1}]}]}});
  assert.equal(s.percent, 42); assert.equal(s.layer, 80); assert.equal(s.task, 'cable_dock_v2');
  assert.deepEqual(s.ams[0].trays[0], {slot:'1', active:true, type:'PETG', name:'', color:'#00ae42', remain:null});
  assert.equal(summarize({}).gcodeState, 'UNKNOWN');
});

test('connects, reads status, and reports start and finish', async () => {
  const broker = await fakePrinter();
  const printer = new BambuPrinter({host:'127.0.0.1', port:broker.address().port, serial:SERIAL, accessCode:'12345678', useTls:false});
  const events = [];
  printer.on('started', e => events.push(['started', e.task]));
  printer.on('finished', e => events.push(['finished', e.task, e.ok]));
  printer.start();
  try {
    await until(() => printer.status().state?.gcodeState === 'IDLE');
    const status = printer.status();
    assert.equal(status.connected, true);
    assert.equal(status.state.ams[0].trays[0].color, '#ff7a2f');
    assert.ok(broker.seen.some(p => p.type === TYPE.SUBSCRIBE && p.topic === `device/${SERIAL}/report`));
    broker.report({gcode_state:'RUNNING', subtask_name:'dock', mc_percent:10});
    broker.report({mc_percent:55});  // incremental update keeps earlier fields
    await until(() => printer.status().state.percent === 55);
    assert.equal(printer.status().state.task, 'dock');
    broker.report({gcode_state:'FINISH', mc_percent:100});
    await until(() => events.length === 2);
    assert.deepEqual(events, [['started', 'dock'], ['finished', 'dock', true]]);
  } finally { printer.stop(); await broker.closeAll(); }
});

test('a wrong access code is reported, not retried silently', async () => {
  const broker = await fakePrinter('right-code');
  const printer = new BambuPrinter({host:'127.0.0.1', port:broker.address().port, serial:SERIAL, accessCode:'wrong', useTls:false});
  printer.start();
  try {
    await until(() => printer.status().error);
    assert.match(printer.status().error, /access code/);
    assert.equal(printer.status().connected, false);
  } finally { printer.stop(); await broker.closeAll(); }
});

function workspace(tmp) {
  const file = path.join(tmp, 'family.json');
  const seed = migrate(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'seed.json'), 'utf8')));
  const project = seed.projects[0];
  project.status = 'Printing';
  seed.spools = [{id:'sp', brand:'', material:'PLA', colorName:'Orange', colorHex:'#ff7a2f', totalGrams:1000, remainingGrams:500, cost:null, notes:''}];
  const job = {id:'j', projectId:project.id, status:'Printing', revision:'v01', material:'PLA', spoolId:'sp', layerHeight:'0.20', nozzle:'0.4', plate:'', supports:'None', infill:15, notes:'', createdAt:'2026-09-25T10:00:00.000Z', startedAt:new Date(Date.now() - 3600e3).toISOString(), finishedAt:'', grams:60, minutes:60, actualMinutes:null, charge:null, printerTask:''};
  seed.jobs = [job];
  fs.writeFileSync(file, JSON.stringify(seed));
  return file;
}

test('the server links a started print and closes it when the printer finishes', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'print-lab-'));
  const broker = await fakePrinter();
  const printer = new BambuPrinter({host:'127.0.0.1', port:broker.address().port, serial:SERIAL, accessCode:'12345678', useTls:false});
  const file = workspace(tmp);
  const server = makeServer(file, {printer});
  printer.start();
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  try {
    await until(() => printer.status().connected);
    broker.report({gcode_state:'RUNNING', subtask_name:'dock_v01'});
    await until(() => read().jobs[0].printerTask === 'dock_v01');
    broker.report({gcode_state:'FINISH'});
    await until(() => read().jobs[0].status === 'Succeeded');
    const data = read();
    assert.equal(data.spools[0].remainingGrams, 440);
    assert.deepEqual(data.jobs[0].charge, {spoolId:'sp', grams:60});
    assert.equal(data.projects[0].status, 'Done');
    assert.ok(data.jobs[0].actualMinutes >= 59);
  } finally { printer.stop(); await new Promise(r => server.close(() => r())); await broker.closeAll(); fs.rmSync(tmp, {recursive:true, force:true}); }
});

// ---------- AI assistant ----------
function stubClient(reply) {
  const calls = [];
  const message = (text, stop = 'end_turn') => ({stop_reason:stop, content:[{type:'text', text}]});
  return {calls, beta:{messages:{
    create: async (params) => { calls.push(params); return typeof reply === 'function' ? reply(params) : message(JSON.stringify(reply)); },
    stream: (params) => {
      calls.push(params);
      const parts = ['Measure ', 'the cables ', 'first.'];
      return {
        async *[Symbol.asyncIterator]() { for (const text of parts) yield {type:'content_block_delta', delta:{type:'text_delta', text}}; },
        finalMessage: async () => message(parts.join('')),
      };
    },
  }}};
}

function post(port, route, body) {
  const data = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({host:'127.0.0.1', port, path:route, method:'POST', headers:{'Content-Type':'application/json', 'Content-Length':data.length}}, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve([res.statusCode, Buffer.concat(chunks).toString(), res.headers['content-type']]));
    });
    req.on('error', reject); req.end(data);
  });
}

async function withServer(ai, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'print-lab-'));
  const server = makeServer(workspace(tmp), {ai});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try { await fn(server.address().port); } finally { await new Promise(r => server.close(r)); fs.rmSync(tmp, {recursive:true, force:true}); }
}

test('structured suggestions use Opus 5 with fallbacks and the workspace snapshot', async () => {
  const client = stubClient({ideas:[{title:'Rocket pencil cup', category:'Creative', description:'A cup.', material:'PLA', why:'Loves space.', safety:'', checklist:['Measure pencils']}]});
  const ai = createAi({client});
  await withServer(ai, async (port) => {
    const [code, body] = await post(port, '/api/ai/ideas', {profileId:'son', hint:'space'});
    assert.equal(code, 200);
    assert.equal(JSON.parse(body).ideas[0].title, 'Rocket pencil cup');
    const params = client.calls[0];
    assert.equal(params.model, 'claude-opus-5');
    assert.equal(params.fallbacks, 'default');
    assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
    assert.equal(params.output_config.format.type, 'json_schema');
    assert.match(params.system[1].text, /Son \(age 7\)/);
    assert.match(params.messages[0].content.at(-1).text, /space/);
    assert.equal((await post(port, '/api/ai/ideas', {profileId:'nobody'}))[0], 400);
    assert.equal((await post(port, '/api/ai/diagnose', {jobId:'j', image:{mediaType:'image/svg+xml', data:'AAAA'}}))[0], 400);
    assert.equal((await post(port, '/api/ai/unknown', {}))[0], 404);
  });
});

test('chat streams text, refusals are explained, and an unconfigured assistant says so', async () => {
  await withServer(createAi({client:stubClient({})}), async (port) => {
    const [code, body, type] = await post(port, '/api/ai/chat', {messages:[{role:'user', content:'How do I start?'}]});
    assert.equal(code, 200); assert.match(type, /text\/plain/); assert.equal(body, 'Measure the cables first.');
    assert.equal((await post(port, '/api/ai/chat', {messages:[{role:'assistant', content:'hi'}]}))[0], 400);
  });
  await withServer(createAi({client:stubClient(() => ({stop_reason:'refusal', content:[]}))}), async (port) => {
    const [code, body] = await post(port, '/api/ai/checklist', {projectId:'idea-01'});
    assert.equal(code, 422); assert.match(JSON.parse(body).error, /declined/);
  });
  await withServer(createAi({env:{LAB_AI:'off'}}), async (port) => {
    const [code, body] = await post(port, '/api/ai/chat', {messages:[{role:'user', content:'hi'}]});
    assert.equal(code, 503); assert.match(JSON.parse(body).error, /not set up/);
  });
});

test('the snapshot summarises the workspace and printer', () => {
  const state = migrate(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'seed.json'), 'utf8')));
  const text = snapshot(state, {configured:true, connected:true, name:'X2D', state:summarize({gcode_state:'RUNNING', mc_percent:5, subtask_name:'dock'})});
  assert.match(text, /Daughter \(age 4\)/);
  assert.match(text, /X2D: RUNNING, task "dock", 5%/);
  assert.match(snapshot(state, {configured:false}), /not connected/);
});

test('the printer simulator plays out a print the app can follow', async () => {
  const {createSimulator} = require('../tools/printer-sim.js');
  const sim = createSimulator({speed:600, failRate:0, log:() => {}});
  const port = await sim.listen(0);
  const printer = new BambuPrinter({host:'127.0.0.1', port, serial:sim.serial, accessCode:sim.accessCode, useTls:false, simulated:true});
  const events = [];
  printer.on('started', e => events.push(['started', e.task]));
  printer.on('finished', e => events.push(['finished', e.task, e.ok]));
  printer.start();
  try {
    await until(() => printer.status().state?.gcodeState === 'IDLE');
    assert.equal(printer.status().simulated, true);
    assert.equal(printer.status().state.ams[0].trays.filter(t => t.type).length, 3);
    sim.start({name:'sim_test_part', minutes:2, slot:2, grams:100});
    await until(() => events.some(e => e[0] === 'finished'), 8000);
    assert.deepEqual(events, [['started', 'sim_test_part'], ['finished', 'sim_test_part', true]]);
    const s = printer.status().state;
    assert.equal(s.gcodeState, 'FINISH');
    assert.equal(s.percent, 100);
    assert.ok(s.ams[0].trays[2].remain < 92, 'filament in the used slot goes down');
    assert.throws(() => sim.finish(), /Nothing is printing/);
  } finally { printer.stop(); await sim.close(); }
});
