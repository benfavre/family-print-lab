import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ERROR, type Progress } from '$lib/shared/slicer/protocol';
import {
	EngineError,
	StdioEngine,
	closeSlicer,
	openSlicer,
	type StdioEngineOptions
} from './engine';
import { fakeInstall } from './__fixtures__/install';

const FAKE = path.join(import.meta.dirname, '__fixtures__', 'fake-engine.mjs');
const engines: StdioEngine[] = [];
const dirs: string[] = [];

async function fake(env: Record<string, string> = {}, o: Partial<StdioEngineOptions> = {}) {
	const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpl-engine-'));
	dirs.push(workDir);
	const logs: string[] = [];
	const engine = await StdioEngine.open({
		command: process.execPath,
		args: [FAKE],
		workDir,
		env,
		onLog: (level, message) => logs.push(`${level}: ${message}`),
		...o
	});
	engines.push(engine);
	return { engine, logs, workDir };
}

afterEach(async () => {
	await Promise.all(engines.splice(0).map((e) => e.close()));
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('StdioEngine against the fake engine', () => {
	it('negotiates and reports what the engine is', async () => {
		const { engine } = await fake();
		expect(engine.info).toMatchObject({
			engine: 'printlab-slicer',
			protocol: { major: 1 },
			upstream: { name: 'BambuStudio', tag: 'v02.08.02.61' }
		});
		expect(engine.has('slice')).toBe(true);
		expect(engine.has('arrange')).toBe(false);
		expect(await engine.call('engine.ping', {})).toEqual({ ok: true });
	});

	it('refuses an engine with another protocol major', async () => {
		await expect(fake({ FAKE_MAJOR: '2' })).rejects.toThrow('speaks protocol 2.0');
	});

	it('answers CAPABILITY_MISSING locally for a feature the engine lacks', async () => {
		const { engine } = await fake();
		const err = await engine.call('arrange', { projectId: 'p', plate: 1 }).catch((e) => e);
		expect(err).toBeInstanceOf(EngineError);
		expect(err.code).toBe(ERROR.CAPABILITY_MISSING);
		// The engine answers unknown methods itself when they get through: this one never did.
		expect(await engine.call('engine.ping', {})).toEqual({ ok: true });
	});

	it('routes progress to the call and resolves with the result', async () => {
		const { engine } = await fake();
		const progress: Progress[] = [];
		const stats = await engine.call(
			'slice',
			{ projectId: 'p', plate: 1 },
			{ onProgress: (p) => progress.push(p) }
		);
		expect(stats).toMatchObject({ plate: 1, seconds: 600, layers: 50 });
		expect(progress.map((p) => p.percent)).toEqual([30, 60, 90]);
	});

	it('reassembles partial and huge lines', async () => {
		const { engine } = await fake();
		const { presets } = await engine.call('profiles.list', { kind: 'printer' });
		expect(presets[0].name).toHaveLength(3 * 1024 * 1024);
	});

	it('ignores stray stdout text and keeps stderr as logs only', async () => {
		const { engine, logs } = await fake({ FAKE_STRAY: '1' });
		expect(await engine.call('engine.ping', {})).toEqual({ ok: true });
		expect(logs).toContain('warn: Not protocol: upstream says hello on stdout');
	});

	it('turns an engine error into an EngineError with plain words', async () => {
		const { engine } = await fake({ FAKE_CAPS: 'mesh.put' });
		const err = await engine
			.call('mesh.put', { meshId: 'm', path: '/x.stl', format: 'stl' })
			.catch((e) => e);
		expect(err).toMatchObject({ code: ERROR.MESH_NOT_FOUND, message: 'No such mesh.' });
	});

	it('cancels a slice through $/cancel', async () => {
		const { engine } = await fake();
		const abort = new AbortController();
		const call = engine.call(
			'slice',
			{ projectId: 'p', plate: 0 },
			{ signal: abort.signal, onProgress: (p) => p.percent === 60 && abort.abort() }
		);
		await expect(call).rejects.toMatchObject({ code: ERROR.CANCELLED });
		expect(await engine.call('engine.ping', {})).toEqual({ ok: true });
	});

	it('gives up on a call that takes too long', async () => {
		const { engine } = await fake();
		await expect(
			engine.call('slice', { projectId: 'p', plate: 0 }, { timeoutMs: 100 })
		).rejects.toThrow('took too long');
	});

	it('rejects the calls in flight when the engine crashes, and restarts for the next one', async () => {
		const { engine } = await fake({ FAKE_CAPS: 'mesh.put,slice' });
		const slow = engine.call('slice', { projectId: 'p', plate: 0 });
		const crash = engine.call('mesh.put', { meshId: 'crash', path: '/x', format: 'stl' });
		await expect(crash).rejects.toThrow('The slicer stopped unexpectedly.');
		await expect(slow).rejects.toMatchObject({ code: ERROR.INTERNAL });
		expect(engine.starts).toBe(1);
		expect(await engine.call('engine.ping', {})).toEqual({ ok: true });
		expect(engine.starts).toBe(2);
	});

	it('stops when idle and starts again on the next call', async () => {
		const { engine } = await fake({}, { idleMs: 50 });
		await engine.call('engine.ping', {});
		await new Promise((r) => setTimeout(r, 300));
		expect(await engine.call('engine.ping', {})).toEqual({ ok: true });
		expect(engine.starts).toBe(2);
	});

	it('refuses calls after close', async () => {
		const { engine } = await fake();
		await engine.close();
		await expect(engine.call('engine.ping', {})).rejects.toThrow('closed');
	});
});

describe('openSlicer', () => {
	const nothing = {
		platform: 'linux' as const,
		arch: 'x64',
		home: '/nowhere',
		isFile: () => false,
		isExecutable: () => false,
		isDir: () => false,
		readdir: () => []
	};
	/** An executable that runs the fake engine, as a built printlab-slicer would sit on disk. */
	function engineBinary(env: Record<string, string> = {}) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpl-engine-bin-'));
		dirs.push(dir);
		const bin = path.join(dir, 'printlab-slicer');
		const vars = Object.entries(env)
			.map(([k, v]) => `${k}=${v} `)
			.join('');
		fs.writeFileSync(bin, `#!/bin/sh\n${vars}exec "${process.execPath}" "${FAKE}" "$@"\n`);
		fs.chmodSync(bin, 0o755);
		return bin;
	}

	afterEach(() => closeSlicer());

	it('is null when neither the engine nor a command line is installed', async () => {
		expect(await openSlicer({}, { cwd: '/nowhere', host: nothing })).toBeNull();
	});

	it('falls back to the Bambu Studio command line', async () => {
		const install = fakeInstall();
		try {
			const slicer = await openSlicer({ BAMBU_STUDIO_PATH: install.bin }, { cwd: '/nowhere' });
			expect(slicer?.info).toMatchObject({ engine: 'bambu-studio-cli', version: '02.08.02.61' });
			expect(slicer?.has('slice')).toBe(true);
		} finally {
			install.remove();
		}
	});

	it('prefers Print Lab Slicer, and shares one', async () => {
		const install = fakeInstall();
		try {
			const env = { PRINTLAB_SLICER_PATH: engineBinary(), BAMBU_STUDIO_PATH: install.bin };
			const slicer = await openSlicer(env, { cwd: '/nowhere' });
			expect(slicer?.info.engine).toBe('printlab-slicer');
			expect(await openSlicer(env, { cwd: '/nowhere' })).toBe(slicer);
		} finally {
			install.remove();
		}
	});

	it('uses the command line when the engine speaks another protocol', async () => {
		const install = fakeInstall();
		try {
			const env = {
				PRINTLAB_SLICER_PATH: engineBinary({ FAKE_MAJOR: '2' }),
				BAMBU_STUDIO_PATH: install.bin
			};
			const slicer = await openSlicer(env, { cwd: '/nowhere' });
			expect(slicer?.info.engine).toBe('bambu-studio-cli');
		} finally {
			install.remove();
		}
	});
});
