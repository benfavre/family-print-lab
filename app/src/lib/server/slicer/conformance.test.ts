// Protocol conformance of a real printlab-slicer binary: runs when PRINTLAB_SLICER_PATH points at one
// (slicer/scripts/upstream.sh test sets it; a build with -DPRINTLAB_WITH_UPSTREAM=OFF is enough for
// everything here). Skipped otherwise. The engine runs with PRINTLAB_ENGINE_TEST=1, which adds
// test.wait: progress and cancel without slicing.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERROR } from '$lib/shared/slicer/protocol';
import { StdioEngine } from './engine';

const BIN = process.env.PRINTLAB_SLICER_PATH;
const LOCK = path.resolve(import.meta.dirname, '../../../../../slicer/upstream.lock');
const SERIES = path.resolve(import.meta.dirname, '../../../../../slicer/patches/series');

function lock(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of fs.readFileSync(LOCK, 'utf8').split('\n')) {
		const m = line.replace(/(^|\s)#.*$/, '').match(/^\s*([a-z_]+)\s*=\s*(.*?)\s*$/);
		if (m) out[m[1]] = m[2];
	}
	return out;
}

/** One line the engine wrote, as far as these tests look at it. */
interface Line {
	id?: string | number | null;
	method?: string;
	params?: { id?: string | number; progress?: { stage: string } };
	result?: { engine?: string; capabilities?: string[]; ok?: boolean };
	error?: { code: number; data: { message: string } };
}

/** A bare NDJSON client, to see exactly what the engine writes. */
class Raw {
	proc: ChildProcessWithoutNullStreams;
	lines: Line[] = [];
	stray: string[] = [];
	private waiters: (() => void)[] = [];
	constructor(env: Record<string, string> = {}) {
		this.proc = spawn(BIN!, [], { env: { ...process.env, PRINTLAB_ENGINE_TEST: '1', ...env } });
		readline.createInterface({ input: this.proc.stdout }).on('line', (line) => {
			try {
				this.lines.push(JSON.parse(line));
			} catch {
				this.stray.push(line);
			}
			for (const w of this.waiters.splice(0)) w();
		});
	}
	send(msg: unknown) {
		this.proc.stdin.write(`${typeof msg === 'string' ? msg : JSON.stringify(msg)}\n`);
	}
	async answer(id: unknown, ms = 5000): Promise<Line> {
		const end = Date.now() + ms;
		for (;;) {
			const found = this.lines.find((l) => l.id === id && ('result' in l || 'error' in l));
			if (found) return found;
			if (Date.now() > end) throw new Error(`No answer to ${String(id)}`);
			await new Promise<void>((r) => {
				this.waiters.push(r);
				setTimeout(r, 50);
			});
		}
	}
	async close() {
		const gone = new Promise((r) => this.proc.once('exit', r));
		this.send({ jsonrpc: '2.0', id: 'bye', method: 'engine.shutdown' });
		this.proc.stdin.end();
		await gone;
	}
}

const hello = (id: unknown = 1, major = 1) => ({
	jsonrpc: '2.0',
	id,
	method: 'engine.hello',
	params: { client: 'conformance', protocol: { major, minor: 0 }, workDir: os.tmpdir() }
});

describe.runIf(!!BIN)('printlab-slicer protocol conformance', () => {
	let raw: Raw;
	beforeAll(() => {
		raw = new Raw();
	});
	afterAll(() => raw?.close());

	it('negotiates with the app’s client and reports the pin it was built from', async () => {
		const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpl-conf-'));
		const engine = await StdioEngine.open({ command: BIN!, workDir });
		try {
			const pin = lock();
			const patches = fs
				.readFileSync(SERIES, 'utf8')
				.split('\n')
				.map((l) => l.replace(/(^|\s)#.*$/, '').trim())
				.filter(Boolean);
			expect(engine.info).toMatchObject({
				engine: 'printlab-slicer',
				protocol: { major: 1 },
				upstream: { name: pin.name, tag: pin.tag, commit: pin.commit },
				patchQueue: { version: Number(pin.queue), hash: pin.queue_hash, patches }
			});
			expect(engine.info.version).toMatch(/^\d+\.\d+\.\d+/);
			expect(await engine.call('engine.ping', {})).toEqual({ ok: true });
		} finally {
			await engine.close();
			fs.rmSync(workDir, { recursive: true, force: true });
		}
	});

	it('keeps stdout for protocol lines only', async () => {
		raw.send(hello());
		expect((await raw.answer(1)).result?.engine).toBe('printlab-slicer');
		expect(raw.stray).toEqual([]);
	});

	it('refuses another protocol major', async () => {
		raw.send(hello(2, 2));
		expect((await raw.answer(2)).error?.code).toBe(ERROR.INVALID_REQUEST);
	});

	it('answers errors with the protocol’s codes and plain words', async () => {
		raw.send('{this is not json');
		raw.send({ jsonrpc: '2.0', id: 3, method: 'no.such.method', params: {} });
		raw.send({ jsonrpc: '2.0', id: 4, method: 'engine.hello', params: {} });
		const unknown = await raw.answer(3);
		expect(unknown.error).toMatchObject({ code: ERROR.METHOD_NOT_FOUND });
		expect(unknown.error?.data.message).toMatch(/\w/);
		expect((await raw.answer(4)).error).toMatchObject({ code: ERROR.INVALID_PARAMS });
		const parse = raw.lines.find((l) => l.error?.code === ERROR.PARSE)!;
		expect(parse).toMatchObject({ id: null });
		expect(parse.error!.data.message).toMatch(/\w/);
	});

	it('answers CAPABILITY_MISSING for a method it does not offer', async () => {
		const caps = (await raw.answer(1)).result?.capabilities ?? [];
		const absent = ['slice', 'arrange', 'orient', 'preview.get'].find(
			(m) => !caps.includes(m === 'preview.get' ? 'preview.v1' : m)
		);
		if (!absent) return; // a full engine offers all of them
		raw.send({
			jsonrpc: '2.0',
			id: 5,
			method: absent,
			params: { projectId: 'p', plate: 1, objectIds: [] }
		});
		expect((await raw.answer(5)).error?.code).toBe(ERROR.CAPABILITY_MISSING);
	});

	it('streams progress for a request and cancels it with $/cancel', async () => {
		raw.send({
			jsonrpc: '2.0',
			id: 'w',
			method: 'test.wait',
			params: { projectId: 'x', steps: 400, stepMs: 5 }
		});
		await new Promise((r) => setTimeout(r, 100));
		raw.send({ jsonrpc: '2.0', id: 6, method: 'engine.ping', params: {} });
		expect((await raw.answer(6)).result).toEqual({ ok: true });
		raw.send({ jsonrpc: '2.0', method: '$/cancel', params: { id: 'w' } });
		expect((await raw.answer('w')).error?.code).toBe(ERROR.CANCELLED);
		const progress = raw.lines.filter((l) => l.method === '$/progress' && l.params?.id === 'w');
		expect(progress.length).toBeGreaterThan(0);
		expect(progress[0].params?.progress).toMatchObject({ stage: 'slicing' });
	});
});
