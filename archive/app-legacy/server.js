#!/usr/bin/env node
'use strict';
// Local family print manager: workspace API, static files, optional printer link and AI assistant.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const Bambu = require('./lib/bambu');
const {createAi} = require('./lib/ai');
const Ledger = require('./static/ledger.js');

const ROOT = __dirname;
const STATUSES = new Set(['Idea', 'Planned', 'Printing', 'Done']);
const COLORS = new Set(['violet', 'blue', 'orange', 'pink', 'green']);
const CATEGORIES = new Set(['Office', 'Home lab', 'Home', 'Creative']);
const CSP = "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const ASSETS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/scene.js': ['scene.js', 'text/javascript; charset=utf-8'],
  '/ledger.js': ['ledger.js', 'text/javascript; charset=utf-8'],
  '/theme-boot.js': ['theme-boot.js', 'text/javascript; charset=utf-8'],
  '/assistant.js': ['assistant.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/fonts/Geist-Variable.woff2': ['fonts/Geist-Variable.woff2', 'font/woff2'],
  '/fonts/GeistMono-Variable.woff2': ['fonts/GeistMono-Variable.woff2', 'font/woff2'],
};

class ValidationError extends Error {}
class ConflictError extends Error {}
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const JOB_STATUSES = new Set(['Queued', 'Printing', 'Succeeded', 'Failed', 'Cancelled']);
const HEX = /^#[0-9a-f]{6}$/i;

// Adds fields introduced after the first release so older files and backups keep loading.
function migrate(data) {
  if (!isObject(data)) return data;
  if (data.jobs === undefined) data.jobs = [];
  if (data.spools === undefined) data.spools = [];
  for (const job of Array.isArray(data.jobs) ? data.jobs : []) if (isObject(job) && job.printerTask === undefined) job.printerTask = '';
  for (const row of Array.isArray(data.projects) ? data.projects : []) {
    if (!isObject(row)) continue;
    if (row.checklist === undefined) row.checklist = [];
    if (row.createdAt === undefined) row.createdAt = '';
    if (row.updatedAt === undefined) row.updatedAt = '';
    if (row.pinned === undefined) row.pinned = false;
  }
  return data;
}

function validate(data) {
  const fail = (message) => { throw new ValidationError(message); };
  const keys = isObject(data) ? Object.keys(data).sort().join() : '';
  if (keys !== 'jobs,profiles,projects,revision,spools') fail('Invalid workspace format.');
  if (!Number.isInteger(data.revision) || data.revision < 0) fail('Invalid revision.');
  for (const [key, limit] of [['profiles', 50], ['projects', 2000], ['jobs', 5000], ['spools', 300]]) {
    if (!Array.isArray(data[key]) || data[key].length > limit) fail(`Too many ${key}.`);
  }
  const string = (row, field, limit = 4000, required = false) => {
    const value = row[field];
    if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) fail(`Invalid ${field}.`);
  };
  const number = (row, field, max, nullable = true) => {
    const value = row[field];
    if (value === null && nullable) return;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) fail(`Invalid ${field}.`);
  };
  const date = (row, field) => {
    string(row, field, 40);
    if (row[field] && Number.isNaN(Date.parse(row[field]))) fail(`Invalid ${field}.`);
  };
  const unique = (seen, id, label) => { if (seen.has(id)) fail(`Duplicate ${label}.`); seen.add(id); };

  const ids = new Set();
  for (const row of data.profiles) {
    if (!isObject(row)) fail('Invalid profile.');
    for (const field of ['id', 'name', 'interests', 'color']) string(row, field, field === 'interests' ? 500 : 80, field === 'id' || field === 'name');
    unique(ids, row.id, 'profile');
    if (!COLORS.has(row.color)) fail('Invalid profile color.');
    const age = row.age;
    if (age !== undefined && age !== null && (!Number.isInteger(age) || age < 0 || age > 120)) fail('Invalid age.');
  }
  const projectIds = new Set();
  for (const row of data.projects) {
    if (!isObject(row)) fail('Invalid project.');
    for (const field of ['id', 'title', 'profileId', 'status', 'category', 'description', 'notes', 'url', 'files', 'material']) {
      string(row, field, ['description', 'notes', 'files'].includes(field) ? 4000 : 1000, ['id', 'title', 'profileId'].includes(field));
    }
    if (!ids.has(row.profileId)) fail('Choose an existing family member.');
    unique(projectIds, row.id, 'project');
    if (!STATUSES.has(row.status)) fail('Invalid print status.');
    if (!CATEGORIES.has(row.category)) fail('Invalid category.');
    if (row.url) {
      let url = null;
      try { url = new URL(row.url); } catch {}
      if (!url || !['https:', 'http:'].includes(url.protocol) || !url.host) fail('Model links must start with https:// or http://.');
    }
    date(row, 'createdAt'); date(row, 'updatedAt');
    if (typeof row.pinned !== 'boolean') fail('Invalid pinned flag.');
    if (!Array.isArray(row.checklist) || row.checklist.length > 60) fail('Invalid checklist.');
    const steps = new Set();
    for (const step of row.checklist) {
      if (!isObject(step) || typeof step.done !== 'boolean') fail('Invalid checklist step.');
      string(step, 'id', 80, true); string(step, 'text', 200, true);
      unique(steps, step.id, 'checklist step');
    }
  }
  const spoolIds = new Set();
  for (const row of data.spools) {
    if (!isObject(row)) fail('Invalid spool.');
    string(row, 'id', 80, true); string(row, 'material', 40, true);
    for (const field of ['brand', 'colorName']) string(row, field, 80);
    string(row, 'notes', 1000);
    if (typeof row.colorHex !== 'string' || !HEX.test(row.colorHex)) fail('Invalid spool color.');
    number(row, 'totalGrams', 100000, false);
    if (row.totalGrams <= 0) fail('Invalid totalGrams.');
    number(row, 'remainingGrams', row.totalGrams, false);
    number(row, 'cost', 100000);
    unique(spoolIds, row.id, 'spool');
  }
  const jobIds = new Set();
  for (const row of data.jobs) {
    if (!isObject(row)) fail('Invalid print job.');
    string(row, 'id', 80, true); string(row, 'projectId', 80, true);
    if (!projectIds.has(row.projectId)) fail('Print jobs must belong to an existing project.');
    unique(jobIds, row.id, 'print job');
    if (!JOB_STATUSES.has(row.status)) fail('Invalid job status.');
    for (const field of ['revision', 'material', 'spoolId', 'layerHeight', 'nozzle', 'plate', 'supports']) string(row, field, 80);
    string(row, 'printerTask', 200);
    string(row, 'notes', 4000);
    if (row.spoolId && !spoolIds.has(row.spoolId)) fail('Choose an existing spool.');
    for (const field of ['createdAt', 'startedAt', 'finishedAt']) date(row, field);
    number(row, 'grams', 20000); number(row, 'minutes', 100000); number(row, 'actualMinutes', 100000); number(row, 'infill', 100);
    if (row.charge !== null) {
      if (!isObject(row.charge) || !spoolIds.has(row.charge.spoolId)) fail('Invalid filament charge.');
      number(row.charge, 'grams', 20000, false);
    }
  }
  return data;
}

class Store {
  constructor(file) {
    this.path = path.resolve(file);
    fs.mkdirSync(path.dirname(this.path), {recursive: true});
    if (!fs.existsSync(this.path)) this.write(validate(migrate(JSON.parse(fs.readFileSync(path.join(ROOT, 'seed.json'), 'utf8')))));
    const current = this.read(), before = JSON.stringify(current);
    validate(migrate(current));
    if (JSON.stringify(current) !== before) this.write(current);
  }

  read() { return JSON.parse(fs.readFileSync(this.path, 'utf8')); }

  write(data) {
    const temporary = this.path.replace(/\.json$/, '') + '.tmp';
    const fd = fs.openSync(temporary, 'w');
    try { fs.writeSync(fd, JSON.stringify(data, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.path);
  }

  // Synchronous read-check-write: Node runs it without interleaving, so no lock is needed.
  update(data) {
    validate(migrate(data));
    const previous = this.read();
    if (data.revision !== previous.revision) throw new ConflictError('This workspace changed in another tab. Close this form, reload, and try again.');
    fs.writeFileSync(this.path.replace(/\.json$/, '') + '.backup.json', JSON.stringify(previous, null, 2) + '\n');
    const updated = structuredClone(data);
    updated.revision += 1;
    this.write(updated);
    return updated;
  }
}

// Links printer events to print jobs: a job whose printerTask matches the printer's task is closed
// automatically when the printer reports FINISH or FAILED, even with no browser open.
function automate(store, printer, log = console) {
  const edit = (mutate) => {
    const current = store.read(), next = structuredClone(current);
    if (mutate(next) === false) return;
    store.update(next);
  };
  printer.on('started', ({task}) => {
    try {
      edit(next => {
        if (!task || next.jobs.some(j => j.status === 'Printing' && j.printerTask === task)) return false;
        const unlinked = next.jobs.filter(j => j.status === 'Printing' && !j.printerTask);
        if (unlinked.length !== 1) return false;
        unlinked[0].printerTask = task;
      });
    } catch (error) { log.warn(`Printer link skipped: ${error.message}`); }
  });
  printer.on('finished', ({task, ok}) => {
    try {
      edit(next => {
        const job = next.jobs.find(j => j.status === 'Printing' && j.printerTask && j.printerTask === task);
        if (!job) return false;
        Ledger.transition(next, job.id, ok ? 'Succeeded' : 'Failed', new Date().toISOString());
        if (!ok && !job.notes) job.notes = 'Printer reported the print as failed.';
      });
    } catch (error) { log.warn(`Could not close the linked print job: ${error.message}`); }
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const length = Number(req.headers['content-length']);
    if (!Number.isInteger(length) || length <= 0 || length > limit) { req.resume(); return reject(new ValidationError('Invalid request size.')); }
    const chunks = []; let received = 0;
    req.on('data', (chunk) => { received += chunk.length; if (received <= length) chunks.push(chunk); });
    req.on('end', () => received === length ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(new ValidationError('Invalid request size.')));
    req.on('error', reject);
  });
}

function makeServer(dataPath = path.join(ROOT, 'data', 'family.json'), {printer = null, ai = createAi({env:{LAB_AI:'off'}})} = {}) {
  const store = new Store(dataPath);
  if (printer) automate(store, printer);
  const printerStatus = () => printer ? printer.status() : {configured:false};
  const server = http.createServer(async (req, res) => {
    const headers = (type) => ({'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP});
    const respond = (code, body, type = 'application/json') => {
      if (!Buffer.isBuffer(body)) body = Buffer.from(JSON.stringify(body));
      // Font files never change, so browsers may keep them; everything else is always fresh.
      res.writeHead(code, {...headers(type), 'Content-Length': body.length, ...(type.startsWith('font/') ? {'Cache-Control': 'public, max-age=604800'} : {})});
      res.end(body);
    };
    const trusted = (mutation) => {
      const port = server.address().port, host = req.headers.host || '';
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
      const origin = req.headers.origin;
      return !mutation || origin === undefined || origin === `http://${host}`;
    };
    const pathname = (req.url || '').split(/[?#]/)[0];
    const json = () => (req.headers['content-type'] || '').split(';')[0].trim() === 'application/json';

    if (req.method === 'GET') {
      if (!trusted(false)) return respond(403, {error: 'Local access only.'});
      if (pathname === '/api/state') return respond(200, store.read());
      if (pathname === '/api/printer') return respond(200, printerStatus());
      if (pathname === '/api/ai') return respond(200, {configured:ai.configured, model:ai.model});
      const asset = Object.hasOwn(ASSETS, pathname) && ASSETS[pathname];
      if (!asset) return respond(404, {error: 'Not found.'});
      return respond(200, fs.readFileSync(path.join(ROOT, 'static', asset[0])), asset[1]);
    }

    if (req.method === 'POST' && pathname.startsWith('/api/ai/')) {
      if (!trusted(true)) return respond(403, {error: 'Local access only.'});
      if (!json()) return respond(415, {error: 'JSON required.'});
      let input;
      try { input = JSON.parse(await readBody(req, 12_000_000)); if (!isObject(input)) throw new ValidationError('Invalid request.'); }
      catch (error) { return respond(400, {error: error instanceof SyntaxError ? 'Invalid JSON.' : error.message}); }
      const task = pathname.slice('/api/ai/'.length);
      if (task === 'chat') {
        let started = false;
        try {
          await ai.chat(store.read(), printerStatus(), input.messages, (text) => {
            if (!started) { started = true; res.writeHead(200, headers('text/plain; charset=utf-8')); }
            res.write(text);
          });
          if (!started) res.writeHead(200, headers('text/plain; charset=utf-8'));
          return res.end();
        } catch (raw) {
          const error = ai.explain(raw);
          if (started) return res.end(`\n\n(Stopped: ${error.message})`);
          return respond(error.status, {error: error.message});
        }
      }
      if (!ai.tasks.includes(task)) return respond(404, {error: 'Not found.'});
      try { return respond(200, await ai.run(task, store.read(), printerStatus(), input)); }
      catch (raw) { const error = ai.explain(raw); return respond(error.status, {error: error.message}); }
    }

    if (req.method !== 'PUT') return respond(405, {error: 'Method not allowed.'});
    if (!trusted(true)) return respond(403, {error: 'Local access only.'});
    if (pathname !== '/api/state') return respond(404, {error: 'Not found.'});
    if (!json()) return respond(415, {error: 'JSON required.'});
    try { respond(200, store.update(JSON.parse(await readBody(req, 8_000_000)))); }
    catch (error) {
      if (error instanceof ConflictError) return respond(409, {error: error.message});
      if (error instanceof ValidationError || error instanceof SyntaxError) return respond(400, {error: error.message});
      respond(500, {error: 'Could not save. Check available disk space and folder permissions.'});
    }
  });
  server.on('close', () => printer?.stop());
  return server;
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  try { process.loadEnvFile(file); return; } catch {}
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

if (require.main === module) {
  const args = process.argv.slice(2), option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  if (args.includes('--help') || args.includes('-h')) { console.log('Usage: node app/server.js [--port 8765] [--data path/to/family.json]\nOptional settings live in app/.env (see app/.env.example).'); process.exit(0); }
  loadEnv(path.join(ROOT, '.env'));
  const port = Number(option('--port') ?? 8765);
  const printer = Bambu.fromEnv();
  const ai = createAi();
  const server = makeServer(option('--data'), {printer, ai});
  server.listen(port, '127.0.0.1', () => {
    console.log(`Family Print Lab: http://127.0.0.1:${server.address().port}`);
    console.log(`  Printer: ${printer ? `${printer.name}${printer.simulated ? ' (SIMULATOR)' : ''} at ${printer.host}:${printer.port}` : 'not configured'} · AI assistant: ${ai.configured ? ai.model : 'not configured'}`);
    printer?.start();
  });
  process.on('SIGINT', () => server.close(() => process.exit(0)));
}

module.exports = {makeServer, Store, validate, migrate};
