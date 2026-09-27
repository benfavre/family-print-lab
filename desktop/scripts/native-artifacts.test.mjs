import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
	platforms,
	validateRun,
	validateArtifacts,
	verifySlicerSource
} from './native-artifacts.mjs';

const repository = 'benfavre/family-print-lab';
function fixture() {
	const run = {
		id: 123,
		repository: { full_name: repository },
		head_repository: { full_name: repository },
		path: '.github/workflows/slicer-build.yml',
		event: 'push',
		status: 'completed',
		conclusion: 'success',
		head_sha: 'a'.repeat(40)
	};
	const jobs = platforms.map((platform) => ({
		name: `engine (${platform})`,
		head_sha: run.head_sha,
		status: 'completed',
		conclusion: 'success',
		steps: [
			'Build the engine',
			'Engine tests, conformance and golden slices',
			'Run actions/upload-artifact@v4'
		].map((name) => ({ name, conclusion: 'success' }))
	}));
	const artifacts = platforms.map((platform, i) => ({
		id: i + 100,
		name: `printlab-slicer-${platform}`,
		expired: false,
		workflow_run: { id: run.id, head_sha: run.head_sha }
	}));
	return { run, jobs, artifacts };
}

test('accepts three passing platforms and pins their immutable artifact IDs', () => {
	const { run, jobs, artifacts } = fixture();
	validateRun(run, repository);
	assert.deepEqual(validateArtifacts(run, jobs, artifacts), {
		'linux-x64': 100,
		'darwin-arm64': 101,
		'win32-x64': 102
	});
});

for (const [label, change] of [
	[
		'foreign repository',
		(run) => {
			run.repository.full_name = 'other/repo';
		}
	],
	[
		'fork source',
		(run) => {
			run.head_repository.full_name = 'other/repo';
		}
	],
	[
		'other workflow',
		(run) => {
			run.path = '.github/workflows/release.yml';
		}
	],
	[
		'pull request',
		(run) => {
			run.event = 'pull_request';
		}
	],
	[
		'unfinished run',
		(run) => {
			run.status = 'in_progress';
		}
	],
	[
		'failed run',
		(run) => {
			run.conclusion = 'failure';
		}
	]
])
	test(`rejects ${label}`, () => {
		const { run } = fixture();
		change(run);
		assert.throws(() => validateRun(run, repository));
	});

test('a green continue-on-error run cannot hide a failed Windows job or step', () => {
	const { run, jobs, artifacts } = fixture();
	jobs[2].conclusion = 'failure';
	assert.throws(() => validateArtifacts(run, jobs, artifacts), /Failed native job/);
	jobs[2].conclusion = 'success';
	jobs[2].steps[1].conclusion = 'failure';
	assert.throws(() => validateArtifacts(run, jobs, artifacts), /golden slices must pass/);
	jobs[2].steps[1].conclusion = 'skipped';
	assert.throws(() => validateArtifacts(run, jobs, artifacts), /golden slices must pass/);
});

test('single-platform retries, skipped uploads and duplicate jobs are insufficient', () => {
	const { run, jobs, artifacts } = fixture();
	assert.throws(
		() => validateArtifacts(run, jobs.slice(0, 1), artifacts),
		/Expected one native job/
	);
	assert.throws(
		() => validateArtifacts(run, [...jobs, jobs[0]], artifacts),
		/Expected one native job/
	);
	jobs[0].steps[2].conclusion = 'skipped';
	assert.throws(() => validateArtifacts(run, jobs, artifacts), /upload-artifact/);
});

for (const [label, change] of [
	[
		'missing',
		(a) => {
			a.pop();
		}
	],
	[
		'duplicate',
		(a) => {
			a.push(a[0]);
		}
	],
	[
		'expired',
		(a) => {
			a[0].expired = true;
		}
	],
	[
		'wrong run',
		(a) => {
			a[0].workflow_run.id++;
		}
	],
	[
		'wrong source',
		(a) => {
			a[0].workflow_run.head_sha = 'b'.repeat(40);
		}
	]
])
	test(`rejects ${label} artifacts`, () => {
		const { run, jobs, artifacts } = fixture();
		change(artifacts);
		assert.throws(() => validateArtifacts(run, jobs, artifacts));
	});

test('compares git sources, allowing docs/workflow changes but rejecting facade, lock and script changes', (t) => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'native-provenance-'));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	const git = (...args) =>
		execFileSync('git', args, {
			cwd,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe']
		}).trim();
	const write = (file, value) => {
		fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
		fs.writeFileSync(path.join(cwd, file), value);
	};
	const commit = () => {
		git('add', '.');
		git('commit', '-qm', 'fixture');
		return git('rev-parse', 'HEAD');
	};
	git('init', '-q');
	git('config', 'user.name', 'Test');
	git('config', 'user.email', 'test@example.invalid');
	write('slicer/engine/facade.cpp', 'original');
	write('slicer/upstream.lock', 'pin');
	write('slicer/scripts/upstream.sh', 'build');
	const source = commit();
	write('slicer/UPSTREAM.md', 'updated build evidence');
	write('docs/parity/STATUS.md', 'updated status');
	write('.github/workflows/release.yml', 'candidate workflow');
	const docs = commit();
	verifySlicerSource(source, docs, cwd);
	for (const file of [
		'slicer/engine/facade.cpp',
		'slicer/upstream.lock',
		'slicer/scripts/upstream.sh'
	]) {
		git('reset', '--hard', docs);
		write(file, 'changed');
		assert.throws(() => verifySlicerSource(source, commit(), cwd), /Native source changed/);
	}
	git('reset', '--hard', docs);
	git('rm', 'slicer/engine/facade.cpp');
	assert.throws(() => verifySlicerSource(source, commit(), cwd), /Native source changed/);
	git('reset', '--hard', docs);
	write('slicer/engine/new.cpp', 'new');
	assert.throws(() => verifySlicerSource(source, commit(), cwd), /Native source changed/);
	assert.throws(() => verifySlicerSource(docs, source, cwd));
});
