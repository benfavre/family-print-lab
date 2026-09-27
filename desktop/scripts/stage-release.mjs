// Stage only verified candidate assets. Never publish, overwrite a tag, or replace an existing draft.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateReleaseAssets } from './release-assets.mjs';

export async function stageRelease({ root, version, appVersion, repository, sha }, { api, gh }) {
	assert.equal(appVersion, version, 'App and desktop versions differ');
	assert.match(repository, /^[\w.-]+\/[\w.-]+$/);
	assert.match(sha, /^[a-f0-9]{40}$/);
	const assets = await validateReleaseAssets(root, version);
	const tag = `v${version}`;
	// API/authentication failures must not look like an absent tag or release.
	for (const endpoint of [`git/ref/tags/${tag}`, `releases/tags/${tag}`]) {
		const response = await api(endpoint);
		assert.equal(
			response.status,
			404,
			`Refusing existing or inaccessible ${endpoint} (${response.status})`
		);
	}
	// Tag lookup documents published releases; list with this write-scoped token also includes drafts.
	// https://docs.github.com/en/rest/releases/releases#list-releases
	for (let page = 1; ; page++) {
		const response = await api(`releases?per_page=100&page=${page}`);
		assert.equal(response.status, 200, 'Could not check existing draft releases');
		const releases = await response.json();
		assert.ok(Array.isArray(releases), 'Invalid release listing');
		assert.ok(
			!releases.some((release) => release.tag_name === tag),
			`Refusing existing release for ${tag}`
		);
		if (releases.length < 100) break;
	}
	const ready = fs.mkdtempSync(path.join(os.tmpdir(), 'printlab-release-'));
	try {
		for (const asset of assets)
			fs.copyFileSync(asset.source, path.join(ready, asset.name), fs.constants.COPYFILE_EXCL);
		const response = await api('git/refs', { ref: `refs/tags/${tag}`, sha });
		assert.equal(
			response.status,
			201,
			'Could not create release tag; no existing ref will be changed'
		);
		assert.equal((await response.json()).object.sha, sha, 'Created tag has the wrong target');
		gh([
			'release',
			'create',
			tag,
			'--repo',
			repository,
			'--verify-tag',
			'--draft',
			'--title',
			`Family Print Lab ${version}`,
			'--notes',
			`Candidate installers passed native provenance, installer smoke and updater checksum checks at ${sha}. Review release notes and assets before publishing.`
		]);
		gh([
			'release',
			'upload',
			tag,
			'--repo',
			repository,
			...assets.map((a) => path.join(ready, a.name))
		]);
		return { tag, sha, assets: assets.map((a) => a.name), draft: true };
	} finally {
		fs.rmSync(ready, { recursive: true, force: true });
	}
}

async function main() {
	const { GITHUB_REPOSITORY: repository, GITHUB_SHA: sha, GH_TOKEN: token } = process.env;
	assert.ok(token, 'GH_TOKEN is required');
	const version = JSON.parse(fs.readFileSync('desktop/package.json', 'utf8')).version;
	const appVersion = JSON.parse(fs.readFileSync('app/package.json', 'utf8')).version;
	const result = await stageRelease(
		{ root: process.argv[2], version, appVersion, repository, sha },
		{
			api: (endpoint, body) =>
				fetch(`https://api.github.com/repos/${repository}/${endpoint}`, {
					method: body ? 'POST' : 'GET',
					headers: {
						Authorization: `Bearer ${token}`,
						Accept: 'application/vnd.github+json',
						'X-GitHub-Api-Version': '2022-11-28',
						'Content-Type': 'application/json'
					},
					body: body ? JSON.stringify(body) : undefined
				}),
			gh: (args) => execFileSync('gh', args, { stdio: 'inherit' })
		}
	);
	fs.appendFileSync(
		process.env.GITHUB_STEP_SUMMARY,
		`Staged **${result.tag}** at ${sha}: ${result.assets.length} verified assets in a draft. Nothing has been published.\n`
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
