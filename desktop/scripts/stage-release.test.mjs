import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseManifest, validateReleaseAssets } from './release-assets.mjs';
import { stageRelease } from './stage-release.mjs';

const version = '2.2.1';
const sha = 'a'.repeat(40);
function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-assets-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const platforms = [
		[
			'linux-x64',
			'latest-linux.yml',
			['Family Print Lab-2.2.1.AppImage', 'family-print-lab_2.2.1_amd64.deb']
		],
		['win32-x64', 'latest.yml', ['Family Print Lab Setup 2.2.1.exe']],
		[
			'darwin-arm64',
			'latest-mac.yml',
			['Family Print Lab-2.2.1-arm64-mac.zip', 'Family Print Lab-2.2.1-arm64.dmg']
		]
	];
	for (const [platform, manifest, names] of platforms) {
		const dir = path.join(root, `desktop-candidate-${platform}`);
		fs.mkdirSync(dir);
		const records = names.map((name) => {
			const bytes = Buffer.from(`installer ${name}`);
			fs.writeFileSync(path.join(dir, name), bytes);
			if (platform !== 'linux-x64')
				fs.writeFileSync(path.join(dir, `${name}.blockmap`), 'block map');
			return {
				url: name.replaceAll(' ', '-'),
				sha512: createHash('sha512').update(bytes).digest('base64'),
				size: bytes.length
			};
		});
		fs.writeFileSync(
			path.join(dir, manifest),
			[
				`version: '${version}'`,
				'files:',
				...records.flatMap((r) => [
					`  - url: ${r.url}`,
					`    sha512: ${r.sha512}`,
					`    size: ${r.size}`
				]),
				`path: ${records[0].url}`,
				`sha512: ${records[0].sha512}`,
				"releaseDate: '2026-09-27T15:27:48.487Z'",
				''
			].join('\n')
		);
	}
	const windows = path.join(root, 'desktop-candidate-win32-x64');
	const manifest = path.join(windows, 'latest.yml');
	const editManifest = (edit) =>
		fs.writeFileSync(manifest, edit(fs.readFileSync(manifest, 'utf8')));
	return { root, windows, manifest, editManifest };
}

test('verifies five installer formats and all updater checksums, preserving blockmaps and safe names', async (t) => {
	const { root } = fixture(t);
	const assets = await validateReleaseAssets(root, version);
	assert.equal(assets.length, 11);
	assert.equal(assets.filter((a) => a.name.endsWith('.yml')).length, 3);
	assert.equal(assets.filter((a) => a.name.endsWith('.blockmap')).length, 3);
	assert.ok(assets.some((a) => a.name === 'Family-Print-Lab-Setup-2.2.1.exe.blockmap'));
	assert.ok(assets.every((a) => !a.name.includes(' ')));
});

for (const [label, edit] of [
	['wrong version', (s) => s.replace("version: '2.2.1'", "version: '2.2.0'")],
	['missing records', (s) => s.replace(/  - url:[\s\S]*?path:/, 'path:')],
	['bad size', (s) => s.replace(/    size: \d+/, '    size: 1')],
	['bad checksum', (s) => s.replaceAll(/sha512: .+/g, 'sha512: incorrect')],
	['legacy path mismatch', (s) => s.replace(/^path: .+/m, 'path: different.exe')],
	[
		'remote URL',
		(s) => s.replaceAll('Family-Print-Lab-Setup-2.2.1.exe', 'https://example.com/setup.exe')
	],
	['parent path', (s) => s.replaceAll('Family-Print-Lab-Setup-2.2.1.exe', '../setup.exe')],
	['duplicate metadata', (s) => `${s}version: 2.2.1\n`],
	['unexpected YAML', (s) => `${s}releaseNotes: |\n  unparsed content\n`]
])
	test(`rejects ${label} before tagging`, async (t) => {
		const { root, editManifest } = fixture(t);
		editManifest(edit);
		const calls = [];
		await assert.rejects(
			stageRelease(
				{ root, version, appVersion: version, repository: 'owner/repo', sha },
				{
					api: (...args) => {
						calls.push(args);
					},
					gh: (...args) => {
						calls.push(args);
					}
				}
			)
		);
		assert.deepEqual(calls, []);
	});

test('detects same-sized corruption, duplicate aliases, missing formats, symlinks and empty blockmaps', async (t) => {
	const { root, windows } = fixture(t);
	const installer = path.join(windows, 'Family Print Lab Setup 2.2.1.exe');
	const original = fs.readFileSync(installer);
	fs.writeFileSync(installer, Buffer.alloc(original.length));
	await assert.rejects(validateReleaseAssets(root, version), /SHA-512 mismatch/);
	fs.writeFileSync(installer, original);
	const alias = path.join(windows, 'Family-Print-Lab-Setup-2.2.1.exe');
	fs.copyFileSync(installer, alias);
	await assert.rejects(validateReleaseAssets(root, version), /ambiguous/);
	fs.rmSync(alias);
	fs.rmSync(installer);
	await assert.rejects(validateReleaseAssets(root, version), /Missing/);
	fs.writeFileSync(alias, original);
	fs.symlinkSync(alias, installer);
	await assert.rejects(validateReleaseAssets(root, version), /Not a regular asset/);
	fs.rmSync(installer);
	fs.renameSync(alias, installer);
	fs.writeFileSync(`${installer}.blockmap`, '');
	await assert.rejects(validateReleaseAssets(root, version), /Empty asset/);
});

test('accepts quoted filenames and CRLF updater manifests', (t) => {
	const { manifest } = fixture(t);
	const text = fs
		.readFileSync(manifest, 'utf8')
		.replace(/(url|path): (.+)/g, '$1: "$2"')
		.replaceAll('\n', '\r\n');
	assert.equal(parseManifest(text).version, version);
});

test('rejects file records after top-level fields and cannot reopen the files section', (t) => {
	const { manifest } = fixture(t);
	const text = fs.readFileSync(manifest, 'utf8');
	const record = text.match(/  - url:[\s\S]*?(?=path:)/)[0];
	assert.throws(() => parseManifest(`${text}${record}`), /File outside files section/);
	assert.throws(() => parseManifest(`${text}files:\n${record}`), /Duplicate files section/);
});

test('finds a draft on a later release-list page even when tag lookup returns 404', async (t) => {
	const { root } = fixture(t);
	const pages = [];
	await assert.rejects(
		stageRelease(
			{ root, version, appVersion: version, repository: 'owner/repo', sha },
			{
				api: async (endpoint, body) => {
					assert.equal(body, undefined, 'Must not create a tag');
					if (!endpoint.startsWith('releases?')) return { status: 404 };
					pages.push(endpoint);
					return {
						status: 200,
						json: async () =>
							pages.length === 1
								? Array.from({ length: 100 }, (_, i) => ({ tag_name: `v0.0.${i}`, draft: false }))
								: [{ tag_name: 'v2.2.1', draft: true }]
					};
				},
				gh: () => assert.fail('Must not create a release')
			}
		),
		/Refusing existing release/
	);
	assert.deepEqual(pages, ['releases?per_page=100&page=1', 'releases?per_page=100&page=2']);
});

test('release-list failure prevents tag creation', async (t) => {
	const { root } = fixture(t);
	await assert.rejects(
		stageRelease(
			{ root, version, appVersion: version, repository: 'owner/repo', sha },
			{
				api: async (endpoint, body) => {
					assert.equal(body, undefined);
					return { status: endpoint.startsWith('releases?') ? 403 : 404 };
				},
				gh: () => assert.fail('Must not create a release')
			}
		),
		/Could not check existing draft releases/
	);
});

for (const status of [200, 401, 403, 500])
	test(`refuses existing/inaccessible tags and releases (${status}) without mutations`, async (t) => {
		const { root } = fixture(t);
		for (const existingAt of [0, 1]) {
			const calls = [];
			await assert.rejects(
				stageRelease(
					{ root, version, appVersion: version, repository: 'owner/repo', sha },
					{
						api: async (endpoint, body) => {
							assert.equal(body, undefined);
							calls.push(endpoint);
							return { status: calls.length - 1 === existingAt ? status : 404 };
						},
						gh: () => assert.fail('Must not call gh')
					}
				),
				/Refusing existing or inaccessible/
			);
		}
	});

test('creates only a new exact-SHA tag and draft, uploads unchanged verified bytes without clobber', async (t) => {
	const { root } = fixture(t);
	const calls = [];
	const result = await stageRelease(
		{ root, version, appVersion: version, repository: 'owner/repo', sha },
		{
			api: async (endpoint, body) => {
				calls.push({ endpoint, body });
				if (endpoint.startsWith('releases?')) return { status: 200, json: async () => [] };
				if (body) {
					assert.deepEqual(body, { ref: 'refs/tags/v2.2.1', sha });
					return { status: 201, json: async () => ({ object: { sha } }) };
				}
				return { status: 404 };
			},
			gh: (args) => {
				calls.push(args);
				if (args[1] === 'create') {
					assert.ok(args.includes('--draft'));
					assert.ok(args.includes('--verify-tag'));
				} else {
					assert.equal(args[1], 'upload');
					assert.equal(args.includes('--clobber'), false);
					assert.equal(args.slice(5).length, 11);
					const installer = args.find((a) => a.endsWith('.exe'));
					assert.equal(
						fs.readFileSync(installer, 'utf8'),
						'installer Family Print Lab Setup 2.2.1.exe'
					);
				}
			}
		}
	);
	assert.equal(calls[3].endpoint, 'git/refs');
	assert.equal(calls[4][1], 'create');
	assert.equal(calls[5][1], 'upload');
	assert.equal(result.draft, true);
});

test('a concurrent tag creation fails without creating or changing any release', async (t) => {
	const { root } = fixture(t);
	await assert.rejects(
		stageRelease(
			{ root, version, appVersion: version, repository: 'owner/repo', sha },
			{
				api: async (endpoint, body) =>
					endpoint.startsWith('releases?')
						? { status: 200, json: async () => [] }
						: { status: body ? 422 : 404 },
				gh: () => assert.fail('Must not create a release')
			}
		),
		/Could not create release tag/
	);
});

test('app/desktop version mismatch fails before network access', async () => {
	await assert.rejects(
		stageRelease(
			{ root: '/unused', version, appVersion: '2.2.0', repository: 'owner/repo', sha },
			{
				api: () => assert.fail('Must not call API'),
				gh: () => assert.fail('Must not call gh')
			}
		),
		/versions differ/
	);
});
