// Read the small electron-builder updater-manifest format, not arbitrary YAML. Unknown structures
// fail closed; all five installers must appear in the three manifests with matching hashes/sizes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const layouts = {
	'linux-x64': { manifest: 'latest-linux.yml', suffixes: ['.AppImage', '.deb'] },
	'win32-x64': { manifest: 'latest.yml', suffixes: ['.exe'] },
	'darwin-arm64': { manifest: 'latest-mac.yml', suffixes: ['.dmg', '.zip'] }
};
const scalar = (value) => {
	if (value.startsWith('"')) return JSON.parse(value);
	if (value.startsWith("'")) {
		assert.ok(value.endsWith("'"), 'Unclosed quoted scalar');
		return value.slice(1, -1).replaceAll("''", "'");
	}
	return value;
};
const filename = (name) => {
	assert.ok(
		typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_. -]*$/.test(name),
		`Unsafe asset name: ${name}`
	);
	return name;
};

export function parseManifest(text) {
	const result = { files: [] };
	let file;
	let inFiles = false;
	for (const line of text.replaceAll('\r\n', '\n').split('\n')) {
		if (!line.trim()) continue;
		if (line === 'files:') {
			assert.equal(inFiles, false, 'Duplicate files section');
			inFiles = true;
			continue;
		}
		const start = /^  - url: (.+)$/.exec(line);
		if (start) {
			assert.ok(inFiles, 'File outside files section');
			file = { url: filename(scalar(start[1])) };
			result.files.push(file);
			continue;
		}
		const property = /^    (sha512|size|blockMapSize): (.+)$/.exec(line);
		if (property) {
			assert.ok(inFiles && file, 'File property outside files section');
			assert.ok(!(property[1] in file), `Duplicate ${property[1]}`);
			file[property[1]] = scalar(property[2]);
			continue;
		}
		const top = /^(version|path|sha512|releaseDate): (.+)$/.exec(line);
		assert.ok(top, `Unsupported updater manifest line: ${line}`);
		assert.ok(!(top[1] in result), `Duplicate ${top[1]}`);
		result[top[1]] = scalar(top[2]);
		file = undefined;
	}
	assert.ok(result.files.length > 0, 'Empty updater files');
	assert.equal(result.path, result.files[0].url, 'Legacy updater path differs from first file');
	assert.equal(
		result.sha512,
		result.files[0].sha512,
		'Legacy updater hash differs from first file'
	);
	return result;
}

export async function validateReleaseAssets(root, version) {
	assert.match(version, /^\d+\.\d+\.\d+$/, 'Expected a stable release version');
	assert.deepEqual(
		fs.readdirSync(root).sort(),
		Object.keys(layouts)
			.map((p) => `desktop-candidate-${p}`)
			.sort(),
		'Expected exactly three candidate artifacts'
	);
	const escapedVersion = version.replaceAll('.', '\\.');
	const versionPattern = new RegExp(`(?<![0-9.])${escapedVersion}(?![0-9]|\\.[0-9])`);
	const assets = [];
	const add = (source, name) => {
		filename(name);
		assert.ok(!assets.some((a) => a.name === name), `Duplicate release asset: ${name}`);
		assets.push({ source, name });
	};
	for (const [platform, { manifest, suffixes }] of Object.entries(layouts)) {
		const dir = path.join(root, `desktop-candidate-${platform}`);
		assert.ok(fs.lstatSync(dir).isDirectory(), `Not a candidate artifact directory: ${platform}`);
		const names = fs.readdirSync(dir);
		for (const name of names) {
			filename(name);
			assert.ok(fs.lstatSync(path.join(dir, name)).isFile(), `Not a regular asset: ${name}`);
			assert.ok(fs.statSync(path.join(dir, name)).size > 0, `Empty asset: ${name}`);
			assert.ok(
				name === manifest ||
					suffixes.some((s) => name.endsWith(s) || name.endsWith(`${s}.blockmap`)),
				`Unexpected asset: ${name}`
			);
			if (name !== manifest) assert.match(name, versionPattern, `Wrong asset version: ${name}`);
		}
		const parsed = parseManifest(fs.readFileSync(path.join(dir, manifest), 'utf8'));
		assert.equal(parsed.version, version, `Wrong version in ${manifest}`);
		assert.equal(parsed.files.length, suffixes.length, `Wrong file count in ${manifest}`);
		const published = new Map();
		for (const suffix of suffixes) {
			const records = parsed.files.filter((f) => f.url.endsWith(suffix));
			assert.equal(records.length, 1, `Expected one ${suffix} record in ${manifest}`);
			const record = records[0];
			// app-builder-lib 26.15.3 platformPackager.computeSafeArtifactNameIfNeeded replaces spaces
			// with hyphens; publish/updateInfoBuilder uses that safeArtifactName for GitHub URLs.
			// dist keeps the local filename, so stage exactly the URL the updater will request.
			const matches = names.filter(
				(name) => name === record.url || name.replaceAll(' ', '-') === record.url
			);
			assert.equal(matches.length, 1, `Missing or ambiguous installer: ${record.url}`);
			const name = matches[0];
			const source = path.join(dir, name);
			assert.match(String(record.size), /^[1-9][0-9]*$/, `Invalid size: ${name}`);
			assert.equal(fs.statSync(source).size, Number(record.size), `Size mismatch: ${name}`);
			const hash = createHash('sha512');
			for await (const chunk of fs.createReadStream(source)) hash.update(chunk);
			assert.equal(hash.digest('base64'), record.sha512, `SHA-512 mismatch: ${name}`);
			published.set(name, record.url);
			add(source, record.url);
		}
		assert.equal(
			names.filter((name) => suffixes.some((s) => name.endsWith(s))).length,
			suffixes.length,
			'Unexpected extra installer'
		);
		for (const name of names.filter((n) => n.endsWith('.blockmap'))) {
			const installer = published.get(name.slice(0, -'.blockmap'.length));
			assert.ok(installer, `Orphan blockmap: ${name}`);
			add(path.join(dir, name), `${installer}.blockmap`);
		}
		add(path.join(dir, manifest), manifest);
	}
	return assets;
}
