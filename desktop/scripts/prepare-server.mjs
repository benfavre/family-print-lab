// Builds the Family Print Lab server into desktop/server/ for the Electron app: the SvelteKit build,
// the database migrations and the resources (fonts, Blender scripts) it loads by relative path.
// Then checks that every package the built server imports is a dependency of the desktop app.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = path.resolve(desktop, '../app');
const server = path.join(desktop, 'server');

fs.rmSync(server, { recursive: true, force: true });
fs.mkdirSync(server, { recursive: true });

console.log('• building the web app');
execFileSync('npm', ['run', 'build'], {
	cwd: app,
	stdio: 'inherit',
	// npm is npm.cmd on Windows, which needs a shell.
	shell: process.platform === 'win32',
	env: { ...process.env, BUILD_DIR: path.relative(app, path.join(server, 'build')) }
});

for (const dir of ['drizzle', 'resources']) {
	fs.cpSync(path.join(app, dir), path.join(server, dir), {
		recursive: true,
		filter: (src) => !src.includes('__pycache__')
	});
}
// The settings template the desktop app offers as printlab.env.
fs.copyFileSync(path.join(app, '.env.example'), path.join(server, 'env.example'));
console.log('• copied drizzle/, resources/ and env.example');

// The build is ES modules; say so for its folder (main.cjs outside it stays CommonJS).
fs.writeFileSync(path.join(server, 'package.json'), '{ "type": "module" }\n');

// Every package the server needs must be installed next to it: load each chunk of the build from
// here, the way the app will, and fail if any import cannot be found.
const check = `
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); e.isDirectory() ? walk(f) : f.endsWith('.js') && files.push(f); } };
walk(path.resolve('build/server'));
const missing = new Set();
for (const f of files) {
	try { await import(pathToFileURL(f).href); }
	catch (e) { const m = /Cannot find (?:package|module) '([^']+)'/.exec(e.message); if (m) missing.add(m[1]); }
}
console.log(JSON.stringify({ chunks: files.length, missing: [...missing] }));
process.exit(0);`;
const out = execFileSync(process.execPath, ['--input-type=module', '-e', check], {
	cwd: server,
	env: { ...process.env, DATABASE_URL: ':memory:' },
	encoding: 'utf8'
});
const result = JSON.parse(out.trim().split('\n').pop());
if (result.missing.length) {
	console.error(`✘ The server needs packages the desktop app does not install: ${result.missing.join(', ')}`);
	process.exit(1);
}
console.log(`• all ${result.chunks} server chunks load with the desktop app's packages`);
