// Exercise the distributed installer, including its native libraries, Electron, SQLite and UI.
// CI stages a draft release first; a failed smoke check must prevent publication.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '../../app/node_modules/playwright/index.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = path.join(desktop, 'release');
const version = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')).version;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'printlab-installer-'));
const report = path.join(release, `smoke-${process.platform}`);
let app;
function run(command, args, options = {}) {
	return execFileSync(command, args, {
		encoding: 'utf8',
		timeout: 120_000,
		...options
	});
}
function installer(suffix) {
	const matches = fs
		.readdirSync(release)
		.filter((name) => name.includes(version) && name.endsWith(suffix));
	assert.equal(matches.length, 1, `Expected one ${suffix} installer for ${version}`);
	return path.join(release, matches[0]);
}

try {
	let executable;
	let resources;
	if (process.platform === 'linux') {
		const image = installer('.AppImage');
		fs.chmodSync(image, 0o755);
		run(image, ['--appimage-extract'], { cwd: temp });
		const root = path.join(temp, 'squashfs-root');
		executable = path.join(root, 'family-print-lab');
		resources = path.join(root, 'resources');
	} else if (process.platform === 'darwin') {
		const mount = path.join(temp, 'mount');
		run('hdiutil', ['attach', '-nobrowse', '-mountpoint', mount, installer('.dmg')]);
		try {
			run('ditto', [
				path.join(mount, 'Family Print Lab.app'),
				path.join(temp, 'Family Print Lab.app')
			]);
		} finally {
			run('hdiutil', ['detach', mount]);
		}
		const contents = path.join(temp, 'Family Print Lab.app/Contents');
		executable = path.join(contents, 'MacOS/Family Print Lab');
		resources = path.join(contents, 'Resources');
	} else if (process.platform === 'win32') {
		const root = path.join(temp, 'installed');
		// NSIS requires /D last and without embedded quotes, even when the path contains spaces.
		run(installer('.exe'), ['/S', `/D=${root}`], { windowsVerbatimArguments: true });
		executable = path.join(root, 'Family Print Lab.exe');
		resources = path.join(root, 'resources');
	} else {
		throw new Error(`Unsupported installer platform: ${process.platform}`);
	}
	const engineDir = path.join(resources, 'app/server/engine');
	const manifest = JSON.parse(fs.readFileSync(path.join(engineDir, 'engine.json'), 'utf8'));
	assert.equal(manifest.platform, `${process.platform}-${process.arch}`);
	const engine = path.join(
		engineDir,
		process.platform === 'win32' ? 'printlab-slicer.exe' : 'printlab-slicer'
	);
	const output = run(engine, [], {
		cwd: temp,
		input:
			JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'engine.hello',
				params: {
					client: 'installer-smoke',
					protocol: { major: 1, minor: 0 },
					workDir: temp
				}
			}) + '\n'
	});
	const hello = output
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line))
		.find((line) => line.id === 1)?.result;
	assert.equal(hello?.engine, 'printlab-slicer');
	assert.equal(hello?.patchQueue.hash, manifest.patchQueue.hash);
	for (const capability of [
		'slice',
		'project.open',
		'project.save',
		'preview.v1',
		'config.validate'
	])
		assert.ok(hello.capabilities.includes(capability), `Missing capability: ${capability}`);
	app = await electron.launch({
		executablePath: executable,
		args: ['--no-sandbox', '--disable-gpu', `--user-data-dir=${path.join(temp, 'data')}`],
		env: {
			...process.env,
			CLOUD_URL: '',
			PRINT_LAB_UPDATE_FEED: 'http://127.0.0.1:1'
		},
		timeout: 60_000
	});
	const page = await app.firstWindow({ timeout: 60_000 });
	await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 60_000 });
	await page.waitForLoadState('domcontentloaded');
	const actualVersion = await app.evaluate(({ app }) => app.getVersion());
	assert.equal(actualVersion, version);
	const actualData = await app.evaluate(({ app }) => app.getPath('userData'));
	assert.equal(
		path.resolve(actualData),
		path.join(temp, 'data'),
		'Installer smoke data must be isolated'
	);
	assert.match(page.url(), /^http:\/\/127\.0\.0\.1:\d+\//);
	const body = await page.locator('body').innerText();
	assert.ok(body.trim().length > 20, 'Packaged app rendered an empty page');
	assert.doesNotMatch(body, /Internal Error|Error 500/);
	const backendResponse = await page.request.get(new URL('/api/slicer-ui/info', page.url()).href);
	assert.equal(backendResponse.status(), 200);
	const backend = await backendResponse.json();
	assert.equal(
		backend.engine,
		'printlab-slicer',
		'Packaged server did not discover its native engine'
	);
	assert.ok(backend.capabilities.includes('config.validate'));
	await page.screenshot({ path: `${report}.png` });
	const result = {
		version,
		platform: manifest.platform,
		url: page.url(),
		title: await page.title(),
		engine: hello,
		backend
	};
	fs.writeFileSync(`${report}.json`, JSON.stringify(result, null, 2));
	console.log(JSON.stringify(result, null, 2));
} finally {
	if (app) await app.close();
	fs.rmSync(temp, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 200
	});
}
