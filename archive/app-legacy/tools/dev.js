#!/usr/bin/env node
'use strict';
// Starts the printer simulator and the app together, already connected. Ctrl+C stops both.
// Uses its own env, so app/.env printer settings are left alone, and a separate workspace copy
// (data/dev.json, made from data/family.json on first run) so simulated prints never touch real data.
// Pass --real-data to use data/family.json instead.
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2), realData = args.includes('--real-data'), simArgs = args.filter(a => a !== '--real-data');
const dataDir = path.join(root, 'data'), devData = path.join(dataDir, 'dev.json'), realFile = path.join(dataDir, 'family.json');
if (!realData && !fs.existsSync(devData)) { fs.mkdirSync(dataDir, {recursive:true}); if (fs.existsSync(realFile)) fs.copyFileSync(realFile, devData); }
console.log(realData ? '[dev] Using your real workspace (data/family.json).' : '[dev] Using a separate workspace copy (data/dev.json). Delete it to start fresh from your real data.');
const sim = spawn(process.execPath, [path.join(__dirname, 'printer-sim.js'), ...simArgs], {stdio:['inherit', 'inherit', 'inherit']});
const app = spawn(process.execPath, [path.join(root, 'server.js'), ...(realData ? [] : ['--data', devData])], {stdio:['ignore', 'inherit', 'inherit'], env:{...process.env,
  BAMBU_HOST:'127.0.0.1', BAMBU_PORT:'1883', BAMBU_TLS:'off', BAMBU_SERIAL:'SIM-X2D-0001', BAMBU_ACCESS_CODE:'12345678', BAMBU_NAME:'Bambu Lab X2D', BAMBU_SIMULATED:'1'}});
const stop = () => { sim.kill('SIGINT'); app.kill('SIGINT'); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of [sim, app]) child.on('exit', code => { stop(); process.exitCode = code ?? 0; });
