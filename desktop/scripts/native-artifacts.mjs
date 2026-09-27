// Candidate installers may reuse native binaries only from this repository's completed Slicer build.
// engine.json identifies upstream and patches, not our facade code: compare the actual git sources.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const platforms = ['linux-x64', 'darwin-arm64', 'win32-x64'];
const requiredSteps = [
	'Build the engine',
	'Engine tests, conformance and golden slices',
	'Run actions/upload-artifact@v4'
];

export function validateRun(run, repository) {
	assert.equal(run.repository?.full_name, repository, 'Native run belongs to another repository');
	assert.equal(
		run.head_repository?.full_name,
		repository,
		'Native source belongs to another repository'
	);
	assert.equal(run.path, '.github/workflows/slicer-build.yml', 'Not a Slicer build workflow');
	assert.ok(['push', 'workflow_dispatch'].includes(run.event), 'Untrusted native run event');
	assert.equal(run.status, 'completed', 'Native run has not finished');
	assert.equal(run.conclusion, 'success', 'Native run did not succeed');
	assert.match(run.head_sha, /^[a-f0-9]{40}$/, 'Invalid native source commit');
}

export function validateArtifacts(run, jobs, artifacts) {
	return Object.fromEntries(
		platforms.map((platform) => {
			const matchingJobs = jobs.filter((job) => job.name === `engine (${platform})`);
			assert.equal(matchingJobs.length, 1, `Expected one native job for ${platform}`);
			const job = matchingJobs[0];
			assert.equal(job.head_sha, run.head_sha, `Wrong job source for ${platform}`);
			assert.equal(job.status, 'completed', `Unfinished native job for ${platform}`);
			assert.equal(job.conclusion, 'success', `Failed native job for ${platform}`);
			// continue-on-error can make the overall run green despite a failed platform.
			for (const name of requiredSteps)
				assert.equal(
					job.steps?.find((step) => step.name === name)?.conclusion,
					'success',
					`${platform}: ${name} must pass`
				);
			const matches = artifacts.filter((a) => a.name === `printlab-slicer-${platform}`);
			assert.equal(matches.length, 1, `Expected one artifact for ${platform}`);
			const artifact = matches[0];
			assert.equal(artifact.expired, false, `Expired artifact for ${platform}`);
			assert.equal(artifact.workflow_run?.id, run.id, `Wrong artifact run for ${platform}`);
			assert.equal(
				artifact.workflow_run?.head_sha,
				run.head_sha,
				`Wrong artifact source for ${platform}`
			);
			assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0, 'Invalid artifact ID');
			return [platform, artifact.id];
		})
	);
}

export function verifySlicerSource(source, candidate, cwd = process.cwd()) {
	const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
	// The source must be part of the candidate's history, not an unrelated same-tree branch.
	git('merge-base', '--is-ancestor', source, candidate);
	const changed = git('diff', '--name-only', '-z', source, candidate, '--', 'slicer')
		.split('\0')
		.filter((file) => file && !file.endsWith('.md'));
	assert.deepEqual(changed, [], `Native source changed: ${changed.join(', ')}`);
}

async function main() {
	const {
		NATIVE_RUN_ID: runId,
		GITHUB_REPOSITORY: repository,
		GITHUB_SHA: candidate,
		GH_TOKEN: token
	} = process.env;
	assert.match(runId ?? '', /^[1-9][0-9]*$/, 'NATIVE_RUN_ID must be a positive integer');
	assert.match(repository ?? '', /^[\w.-]+\/[\w.-]+$/, 'Invalid repository');
	assert.match(candidate ?? '', /^[a-f0-9]{40}$/, 'Invalid candidate commit');
	assert.ok(token, 'GH_TOKEN is required');
	const api = async (suffix) => {
		const response = await fetch(
			`https://api.github.com/repos/${repository}/actions/runs/${runId}${suffix}`,
			{
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: 'application/vnd.github+json',
					'X-GitHub-Api-Version': '2022-11-28'
				}
			}
		);
		assert.ok(response.ok, `GitHub API failed (${response.status}) for ${suffix || 'run'}`);
		return response.json();
	};
	const run = await api('');
	validateRun(run, repository);
	verifySlicerSource(run.head_sha, candidate);
	const list = async (suffix, key) => {
		const all = [];
		for (let page = 1; ; page++) {
			const result = await api(
				`${suffix}${suffix.includes('?') ? '&' : '?'}per_page=100&page=${page}`
			);
			all.push(...result[key]);
			if (result[key].length < 100) return all;
		}
	};
	const [jobs, artifacts] = await Promise.all([
		list('/jobs?filter=latest', 'jobs'),
		list('/artifacts', 'artifacts')
	]);
	const ids = validateArtifacts(run, jobs, artifacts);
	fs.appendFileSync(
		process.env.GITHUB_OUTPUT,
		Object.entries(ids)
			.map(([key, id]) => `${key}=${id}\n`)
			.join('')
	);
	fs.appendFileSync(
		process.env.GITHUB_STEP_SUMMARY,
		`Native artifacts verified from run ${run.id} (${run.head_sha}) for candidate ${candidate}. Slicer code is unchanged; only Markdown is excluded.\n\n` +
			Object.entries(ids)
				.map(([platform, id]) => `- ${platform}: artifact ${id}\n`)
				.join('')
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
