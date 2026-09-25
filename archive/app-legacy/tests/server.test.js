'use strict';
const {test, beforeEach, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {makeServer, Store} = require('../server.js');

let tmp, file, server, port;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'print-lab-'));
  file = path.join(tmp, 'family.json');
  server = makeServer(file);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, {recursive: true, force: true});
});

function request(route = '/api/state', data, headers = {}) {
  const body = data === undefined ? null : Buffer.from(JSON.stringify(data));
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, path: route, method: body ? 'PUT' : 'GET', headers: {'Content-Type': 'application/json', ...(body ? {'Content-Length': body.length} : {}), ...headers}}, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        const json = route === '/api/state' || res.statusCode >= 400;
        resolve([res.statusCode, json ? JSON.parse(text) : text]);
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('complete project and profile lifecycle persists', async () => {
  const [code, initial] = await request();
  assert.equal(code, 200);
  assert.equal(initial.profiles.length, 4);
  assert.equal(initial.projects.length, 16);
  initial.profiles[0].name = 'Alex';
  initial.profiles.push({id: 'guest', name: 'Guest', age: null, color: 'pink', interests: 'Art'});
  initial.projects.push({...structuredClone(initial.projects[0]), id: 'new-print', profileId: 'guest', title: 'Test stand', status: 'Planned'});
  let [status, saved] = await request('/api/state', initial);
  assert.equal(status, 200);
  assert.equal(saved.revision, 1);
  for (const next of ['Printing', 'Done']) {
    saved.projects.at(-1).status = next;
    [status, saved] = await request('/api/state', saved);
    assert.equal(status, 200);
  }
  // A new store instance sees the saved profile and completed print.
  const recovered = new Store(file).read();
  assert.equal(recovered.profiles[0].name, 'Alex');
  assert.equal(recovered.projects.at(-1).status, 'Done');
  saved.projects.pop();
  saved.profiles.pop();
  assert.equal((await request('/api/state', saved))[0], 200);
  assert.ok(fs.existsSync(path.join(tmp, 'family.backup.json')));
});

test('stale tab cannot overwrite newer changes', async () => {
  const [, first] = await request();
  const second = structuredClone(first);
  first.projects[0].status = 'Done';
  assert.equal((await request('/api/state', first))[0], 200);
  assert.equal((await request('/api/state', second))[0], 409);
  assert.equal((await request())[1].projects[0].status, 'Done');
});

test('invalid records do not change saved data', async () => {
  const [, original] = await request();
  const changes = [
    (d) => d.profiles.shift(),
    (d) => { d.projects[0].url = 'javascript:alert(1)'; },
    (d) => { d.projects[0].status = 'Unknown'; },
    (d) => { d.profiles[0].age = -1; },
    (d) => d.projects.push(structuredClone(d.projects[0])),
  ];
  for (const mutate of changes) {
    const data = structuredClone(original);
    mutate(data);
    assert.equal((await request('/api/state', data))[0], 400);
    assert.deepEqual((await request())[1], original);
  }
});

test('local origin and asset boundary', async () => {
  const [, data] = await request();
  assert.equal((await request('/api/state', data, {Origin: 'https://example.com'}))[0], 403);
  assert.equal((await request('/api/state', undefined, {Host: 'example.com'}))[0], 403);
  assert.equal((await request('/seed.json'))[0], 404);
  assert.equal((await request('/../server.js'))[0], 404);
  assert.equal((await request('/constructor'))[0], 404);
  for (const asset of ['/', '/app.js', '/scene.js', '/ledger.js', '/assistant.js', '/theme-boot.js', '/style.css', '/favicon.svg', '/fonts/Geist-Variable.woff2']) assert.equal((await request(asset))[0], 200);
});

test('print jobs and spools persist and are cross-checked', async () => {
  const [, data] = await request();
  assert.deepEqual([data.jobs, data.spools], [[], []]);
  assert.deepEqual(data.projects[0].checklist, []);
  assert.equal(data.projects[0].pinned, false);
  const spool = {id: 'sp1', brand: 'Bambu', material: 'PLA', colorName: 'Jade', colorHex: '#00ae42', totalGrams: 1000, remainingGrams: 880, cost: 20, notes: ''};
  const job = {id: 'j1', projectId: data.projects[0].id, status: 'Succeeded', revision: 'v01', material: 'PLA', spoolId: 'sp1', layerHeight: '0.20', nozzle: '0.4', plate: 'Textured PEI', supports: 'None', notes: '', createdAt: '2026-09-25T10:00:00.000Z', startedAt: '2026-09-25T10:05:00.000Z', finishedAt: '2026-09-25T11:05:00.000Z', grams: 120, minutes: 60, actualMinutes: 60, infill: 15, charge: {spoolId: 'sp1', grams: 120}};
  data.spools.push(spool);
  data.jobs.push(job);
  data.projects[0].checklist = [{id: 'c1', text: 'Measure the desk', done: true}];
  const [code, saved] = await request('/api/state', data);
  assert.equal(code, 200);
  assert.equal(saved.jobs[0].charge.grams, 120);

  const bad = [
    (d) => { d.jobs[0].projectId = 'missing'; },
    (d) => { d.jobs[0].spoolId = 'missing'; },
    (d) => { d.jobs[0].status = 'Paused'; },
    (d) => { d.jobs[0].grams = -5; },
    (d) => { d.jobs[0].startedAt = 'yesterday-ish'; },
    (d) => { d.jobs[0].charge = {spoolId: 'missing', grams: 1}; },
    (d) => { d.spools[0].remainingGrams = 1200; },
    (d) => { d.spools[0].colorHex = 'red'; },
    (d) => { d.projects[0].checklist[0].done = 'yes'; },
    (d) => { d.projects[0].pinned = 'yes'; },
    (d) => d.jobs.push(structuredClone(d.jobs[0])),
  ];
  for (const mutate of bad) {
    const copy = structuredClone(saved);
    mutate(copy);
    assert.equal((await request('/api/state', copy))[0], 400);
  }
  assert.deepEqual((await request())[1], saved);
});

test('older workspace files and backups are migrated', async () => {
  const [, current] = await request();
  const legacy = structuredClone(current);
  delete legacy.jobs; delete legacy.spools;
  for (const project of legacy.projects) { delete project.checklist; delete project.createdAt; delete project.updatedAt; }
  // Restoring an old backup through the API works.
  const [code, restored] = await request('/api/state', legacy);
  assert.equal(code, 200);
  assert.deepEqual(restored.jobs, []);
  // An old file on disk is upgraded when the store opens it.
  fs.writeFileSync(file, JSON.stringify(legacy));
  const upgraded = new Store(file).read();
  assert.deepEqual(upgraded.spools, []);
  assert.deepEqual(upgraded.projects[0].checklist, []);
});
