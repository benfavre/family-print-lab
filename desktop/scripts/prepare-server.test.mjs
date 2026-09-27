import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const source = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prepare-server.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'printlab-desktop-bundle-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const bin = path.join(temp, 'bin');
fs.mkdirSync(bin);
// A tiny stand-in for `bun run build`, executed with Node. No web build, network or dependencies;
// using an executable also exercises Windows without relying on .cmd files or shell invocation.
const bun = path.join(bin, process.platform === 'win32' ? 'bun.exe' : 'bun');
try {
	fs.linkSync(process.execPath, bun);
} catch {
	fs.copyFileSync(process.execPath, bun);
}

function fixture(name) {
	const root = path.join(temp, name);
	const app = path.join(root, 'app');
	const desktop = path.join(root, 'desktop');
	const engine = path.join(root, 'slicer/dist', `${process.platform}-${process.arch}`);
	for (const dir of ['drizzle', 'resources/bambu/profiles'])
		fs.mkdirSync(path.join(app, dir), { recursive: true });
	fs.mkdirSync(path.join(desktop, 'scripts'), { recursive: true });
	fs.mkdirSync(engine, { recursive: true });
	fs.writeFileSync(path.join(app, 'resources/bambu/profiles/BBL.json'), '{}');
	fs.writeFileSync(path.join(app, 'drizzle/0000.sql'), '-- migration');
	fs.writeFileSync(path.join(app, '.env.example'), 'HOST=127.0.0.1');
	fs.writeFileSync(path.join(app, 'package.json'), '{"type":"module"}');
	fs.writeFileSync(
		path.join(app, 'run'),
		`import fs from 'node:fs';
import path from 'node:path';
if (process.argv[2] !== 'build') throw new Error('Expected bun run build');
fs.mkdirSync(path.join(process.env.BUILD_DIR, 'server'), { recursive: true });
fs.writeFileSync(path.join(process.env.BUILD_DIR, 'server/index.js'), 'export default 1;');`
	);
	fs.copyFileSync(source, path.join(desktop, 'scripts/prepare-server.mjs'));
	return {
		engine,
		server: path.join(desktop, 'server'),
		run: (env = {}) =>
			execFileSync(process.execPath, [path.join(desktop, 'scripts/prepare-server.mjs')], {
				encoding: 'utf8',
				stdio: 'pipe',
				env: {
					...process.env,
					PRINTLAB_REQUIRE_NATIVE_ENGINE: '',
					...env,
					PATH: `${bin}${path.delimiter}${process.env.PATH}`
				}
			})
	};
}

test('copies the complete platform bundle, including runtime libraries and executable permissions', () => {
	const f = fixture('bundled');
	const executable = process.platform === 'win32' ? 'printlab-slicer.exe' : 'printlab-slicer';
	fs.writeFileSync(path.join(f.engine, 'engine.json'), '{"engine":"printlab-slicer"}');
	fs.writeFileSync(path.join(f.engine, executable), 'test engine', {
		mode: 0o644
	});
	fs.writeFileSync(path.join(f.engine, 'libgmp-10.dll'), 'test runtime');
	fs.mkdirSync(path.join(f.engine, 'resources'));
	fs.writeFileSync(path.join(f.engine, 'resources/model.json'), '{}');
	assert.match(f.run({ PRINTLAB_REQUIRE_NATIVE_ENGINE: '1' }), /copied Print Lab Slicer/);
	assert.equal(
		fs.readFileSync(path.join(f.server, 'engine/libgmp-10.dll'), 'utf8'),
		'test runtime'
	);
	assert.equal(fs.readFileSync(path.join(f.server, 'engine/resources/model.json'), 'utf8'), '{}');
	assert.equal(fs.readFileSync(path.join(f.server, 'drizzle/0000.sql'), 'utf8'), '-- migration');
	if (process.platform !== 'win32')
		assert.equal(fs.statSync(path.join(f.server, 'engine', executable)).mode & 0o777, 0o755);
});

test('refuses a manifest without the platform executable', () => {
	const f = fixture('incomplete');
	fs.writeFileSync(path.join(f.engine, 'engine.json'), '{}');
	assert.throws(f.run, /Incomplete Print Lab Slicer bundle/);
});

test('keeps the installed Bambu Studio fallback when no engine was built', () => {
	const f = fixture('fallback');
	assert.match(f.run(), /no Print Lab Slicer build for this platform/);
	assert.equal(fs.existsSync(path.join(f.server, 'engine')), false);
});

test('refuses to package a required native release without its engine bundle', () => {
	const f = fixture('required');
	assert.throws(
		() => f.run({ PRINTLAB_REQUIRE_NATIVE_ENGINE: '1' }),
		/A native Print Lab Slicer bundle is required for this release/
	);
});
