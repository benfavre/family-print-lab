// Exercise the distributed installer, including its native libraries, Electron, SQLite and UI.
// CI stages a draft release first; a failed smoke check must prevent publication.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
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

async function probeEngine(engine, resourcesDir) {
	const child = spawn(engine, [], { cwd: temp });
	const closed = new Promise((resolve) => child.once('close', resolve));
	let stderr = '';
	child.stderr.on('data', (chunk) => {
		stderr = (stderr + chunk).slice(-8000);
	});
	let timer;
	try {
		return await new Promise((resolve, reject) => {
			const replies = [];
			timer = setTimeout(() => reject(new Error(`Packaged engine timed out: ${stderr}`)), 60_000);
			child.on('error', reject);
			child.stdin.on('error', reject);
			readline.createInterface({ input: child.stdout }).on('line', (line) => {
				try {
					const reply = JSON.parse(line);
					if (reply.error) throw new Error(JSON.stringify(reply.error));
					replies.push(reply);
					// EOF means the client has gone away, so keep stdin open until async work finishes.
					if (reply.id === 2) child.stdin.end();
				} catch (error) {
					reject(error);
				}
			});
			child.on('close', (code) =>
				code === 0
					? resolve(replies)
					: reject(new Error(`Packaged engine exited ${code}: ${stderr}`))
			);
			for (const message of [
				{
					jsonrpc: '2.0',
					id: 1,
					method: 'engine.hello',
					params: {
						client: 'installer-smoke',
						protocol: { major: 1, minor: 0 },
						workDir: temp,
						resourcesDir
					}
				},
				{ jsonrpc: '2.0', id: 2, method: 'profiles.list', params: { kind: 'printer' } }
			])
				child.stdin.write(JSON.stringify(message) + '\n');
		});
	} finally {
		clearTimeout(timer);
		if (child.exitCode === null) child.kill();
		await closed;
	}
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
	const replies = await probeEngine(engine, path.join(engineDir, 'resources'));
	const hello = replies.find((line) => line.id === 1)?.result;
	assert.equal(hello?.engine, 'printlab-slicer');
	assert.equal(hello?.patchQueue.hash, manifest.patchQueue.hash);
	assert.equal(
		fs.realpathSync(hello.profiles.dir),
		fs.realpathSync(path.join(engineDir, 'resources/profiles/BBL'))
	);
	const presets = replies.find((line) => line.id === 2)?.result?.presets;
	assert.ok(
		presets?.some((preset) => preset.name.includes('P1S')),
		'Packaged engine could not load its printer profiles'
	);
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
		fs.realpathSync(actualData),
		fs.realpathSync(path.join(temp, 'data')),
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
		printerProfiles: presets.length,
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
