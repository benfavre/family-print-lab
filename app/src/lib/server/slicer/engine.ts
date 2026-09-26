// The slicer engine client: StdioEngine talks to printlab-slicer (our headless engine built from
// Bambu Studio's libslic3r, see slicer/UPSTREAM.md) over the Slicer Engine Protocol
// ($lib/shared/slicer/protocol.ts): newline-delimited JSON-RPC 2.0 on the engine's stdin/stdout, logs
// on stderr. One process is shared; it is started on first use, restarted after a crash and stopped
// after ten idle minutes. Without an engine, openSlicer() returns null and slicer.ts keeps slicing
// through the stock Bambu Studio command line.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	ERROR,
	PROTOCOL,
	compatibleProtocol,
	type EngineCapability,
	type EngineErrorData,
	type EngineInfo,
	type EngineMethod,
	type EngineMethods,
	type Progress
} from '$lib/shared/slicer/protocol';
import { locateEngine } from './locate';

export interface CallOptions {
	signal?: AbortSignal;
	onProgress?: (p: Progress) => void;
	timeoutMs?: number;
}

export interface SlicerEngine {
	readonly info: EngineInfo;
	has(cap: EngineCapability): boolean;
	call<M extends keyof EngineMethods>(
		method: M,
		params: EngineMethods[M]['params'],
		opts?: CallOptions
	): Promise<EngineMethods[M]['result']>;
	close(): Promise<void>;
}

/** An error the engine answered with (codes in protocol.ts ERROR); `message` is plain words for the UI. */
export class EngineError extends Error {
	constructor(
		readonly code: number,
		message: string,
		readonly data?: unknown
	) {
		super(message);
	}
}

/** The capability a method needs; methods not listed are part of every engine. */
export const METHOD_CAPABILITY: Partial<Record<EngineMethod, EngineCapability>> = {
	'mesh.put': 'mesh.put',
	'project.open': 'project.open',
	'project.sync': 'project.sync',
	'project.save': 'project.save',
	'config.validate': 'config.validate',
	arrange: 'arrange',
	orient: 'orient',
	slice: 'slice',
	'export.gcode3mf': 'export.gcode3mf',
	'preview.get': 'preview.v1',
	'profiles.list': 'profiles.list',
	'profiles.resolve': 'profiles.resolve'
};

/** Time limits: slicing and exports can take minutes on big plates, everything else is quick. */
const TIMEOUT_MS: Partial<Record<EngineMethod, number>> = {
	slice: 30 * 60_000,
	'export.gcode3mf': 10 * 60_000,
	'project.open': 5 * 60_000,
	'project.save': 5 * 60_000,
	arrange: 5 * 60_000,
	orient: 5 * 60_000,
	'preview.get': 5 * 60_000
};
const DEFAULT_TIMEOUT_MS = 60_000;
const HELLO_TIMEOUT_MS = 30_000;
const IDLE_MS = 10 * 60_000;
/** A single protocol line larger than this is a broken engine, not a big result (files carry data). */
const MAX_LINE = 64 * 1024 * 1024;
const STDERR_TAIL = 8 * 1024;

export interface StdioEngineOptions {
	/** The engine binary (and arguments, for tests running a script through node). */
	command: string;
	args?: string[];
	/** Files the engine may write; created if missing. */
	workDir: string;
	resourcesDir?: string | null;
	idleMs?: number;
	helloTimeoutMs?: number;
	env?: Record<string, string | undefined>;
	onLog?: (level: string, message: string) => void;
}

interface Pending {
	method: string;
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
	onProgress?: (p: Progress) => void;
	cleanup: () => void;
}

const stopped = () => new EngineError(ERROR.INTERNAL, 'The slicer stopped unexpectedly.');

export class StdioEngine implements SlicerEngine {
	private proc: ChildProcessWithoutNullStreams | null = null;
	private starting: Promise<EngineInfo> | null = null;
	private pending = new Map<number, Pending>();
	private nextId = 1;
	private buffer = '';
	private stderr = '';
	private idle: ReturnType<typeof setTimeout> | null = null;
	private closed = false;
	private current: EngineInfo | null = null;
	/** How many times the process was started (tests watch restarts). */
	starts = 0;

	private constructor(private readonly o: StdioEngineOptions) {}

	/** Starts the engine and negotiates; throws if it cannot speak this client's protocol major. */
	static async open(o: StdioEngineOptions): Promise<StdioEngine> {
		const engine = new StdioEngine(o);
		await engine.ensure();
		return engine;
	}

	get info(): EngineInfo {
		if (!this.current) throw new EngineError(ERROR.INTERNAL, 'The slicer has not started.');
		return this.current;
	}

	has(cap: EngineCapability) {
		return this.current?.capabilities.includes(cap) ?? false;
	}

	async call<M extends keyof EngineMethods>(
		method: M,
		params: EngineMethods[M]['params'],
		opts: CallOptions = {}
	): Promise<EngineMethods[M]['result']> {
		if (this.closed) throw new EngineError(ERROR.INTERNAL, 'The slicer has been closed.');
		if (opts.signal?.aborted) throw new EngineError(ERROR.CANCELLED, 'Cancelled.');
		await this.ensure();
		const cap = METHOD_CAPABILITY[method];
		// Gate locally: an engine one release older may not have a feature, and it should not get the call.
		if (cap && !this.has(cap))
			throw new EngineError(
				ERROR.CAPABILITY_MISSING,
				`This version of the slicer cannot do that yet (${cap}).`,
				{ message: 'Update Print Lab Slicer to use this.', key: cap }
			);
		return this.request(method, params, {
			...opts,
			timeoutMs: opts.timeoutMs ?? TIMEOUT_MS[method] ?? DEFAULT_TIMEOUT_MS
		}) as Promise<EngineMethods[M]['result']>;
	}

	async close() {
		this.closed = true;
		await this.stop();
	}

	/** A running, negotiated process (started or restarted as needed). */
	private async ensure(): Promise<EngineInfo> {
		if (this.proc && this.current) return this.current;
		this.starting ??= this.start().finally(() => (this.starting = null));
		return this.starting;
	}

	private async start(): Promise<EngineInfo> {
		fs.mkdirSync(this.o.workDir, { recursive: true });
		const proc = spawn(this.o.command, this.o.args ?? [], {
			stdio: ['pipe', 'pipe', 'pipe'],
			env: { ...process.env, ...this.o.env },
			windowsHide: true
		});
		this.proc = proc;
		this.starts++;
		this.buffer = '';
		this.stderr = '';
		proc.stdout.setEncoding('utf8');
		proc.stdout.on('data', (chunk: string) => this.onData(chunk));
		proc.stderr.setEncoding('utf8');
		proc.stderr.on('data', (chunk: string) => {
			this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL);
		});
		proc.stdin.on('error', () => {
			/* the exit handler reports it */
		});
		const onGone = (why: Error) => {
			if (this.proc !== proc) return;
			this.proc = null;
			this.current = null;
			this.clearIdle();
			const detail = this.stderr.trim().split('\n').slice(-3).join('\n');
			for (const p of this.pending.values()) {
				p.cleanup();
				const e = stopped();
				(e as { data?: unknown }).data = { message: e.message, detail: detail || why.message };
				p.reject(e);
			}
			this.pending.clear();
		};
		proc.on('error', (e) => onGone(e));
		proc.on('exit', (code, signal) => onGone(new Error(`exit ${code ?? signal}`)));

		const info = (await this.request(
			'engine.hello',
			{
				client: 'family-print-lab',
				protocol: { ...PROTOCOL },
				workDir: this.o.workDir,
				...(this.o.resourcesDir ? { resourcesDir: this.o.resourcesDir } : {})
			},
			{ timeoutMs: this.o.helloTimeoutMs ?? HELLO_TIMEOUT_MS }
		).catch((e) => {
			proc.kill();
			throw e;
		})) as EngineInfo;
		if (!info?.protocol || !compatibleProtocol(info.protocol)) {
			proc.kill();
			throw new EngineError(
				ERROR.INVALID_REQUEST,
				`The slicer speaks protocol ${info?.protocol?.major ?? '?'}.${info?.protocol?.minor ?? '?'}, this app needs ${PROTOCOL.major}.x. Update the app and the slicer together.`
			);
		}
		this.current = info;
		this.armIdle();
		return info;
	}

	private request(
		method: string,
		params: unknown,
		opts: CallOptions & { timeoutMs: number }
	): Promise<unknown> {
		const proc = this.proc;
		if (!proc) return Promise.reject(stopped());
		const id = this.nextId++;
		this.clearIdle();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.notify('$/cancel', { id });
				this.settle(
					id,
					new EngineError(ERROR.INTERNAL, 'The slicer took too long and was stopped.')
				);
			}, opts.timeoutMs);
			const onAbort = () => this.notify('$/cancel', { id });
			opts.signal?.addEventListener('abort', onAbort, { once: true });
			this.pending.set(id, {
				method,
				resolve,
				reject,
				onProgress: opts.onProgress,
				cleanup: () => {
					clearTimeout(timer);
					opts.signal?.removeEventListener('abort', onAbort);
				}
			});
			proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
		});
	}

	private notify(method: string, params: unknown) {
		this.proc?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
	}

	private settle(id: number, outcome: { result: unknown } | Error) {
		const p = this.pending.get(id);
		if (!p) return;
		this.pending.delete(id);
		p.cleanup();
		if (outcome instanceof Error) p.reject(outcome);
		else p.resolve(outcome.result);
		if (!this.pending.size) this.armIdle();
	}

	private onData(chunk: string) {
		this.buffer += chunk;
		let nl: number;
		while ((nl = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, nl).trim();
			this.buffer = this.buffer.slice(nl + 1);
			if (line) this.onLine(line);
		}
		if (this.buffer.length > MAX_LINE) {
			this.o.onLog?.('error', 'The slicer sent a line too long to be protocol; restarting it.');
			this.proc?.kill();
		}
	}

	private onLine(line: string) {
		let msg: {
			id?: number | string | null;
			method?: string;
			params?: Record<string, unknown>;
			result?: unknown;
			error?: { code: number; message: string; data?: EngineErrorData };
		};
		try {
			msg = JSON.parse(line);
		} catch {
			// stdout is protocol only; anything else is a stray print the engine failed to redirect.
			this.o.onLog?.('warn', `Not protocol: ${line.slice(0, 200)}`);
			return;
		}
		if (msg.method === '$/progress') {
			const id = Number(msg.params?.id);
			this.pending.get(id)?.onProgress?.(msg.params?.progress as Progress);
			return;
		}
		if (msg.method === '$/log') {
			this.o.onLog?.(String(msg.params?.level ?? 'info'), String(msg.params?.message ?? ''));
			return;
		}
		if (typeof msg.id !== 'number') return;
		if (msg.error)
			this.settle(
				msg.id,
				new EngineError(
					msg.error.code,
					msg.error.data?.message ?? msg.error.message,
					msg.error.data
				)
			);
		else this.settle(msg.id, { result: msg.result });
	}

	private armIdle() {
		this.clearIdle();
		if (this.pending.size) return;
		this.idle = setTimeout(() => void this.stop(), this.o.idleMs ?? IDLE_MS);
		this.idle.unref?.();
	}

	private clearIdle() {
		if (this.idle) clearTimeout(this.idle);
		this.idle = null;
	}

	/** Asks the engine to shut down, and kills it if it does not within two seconds. */
	private async stop() {
		this.clearIdle();
		const proc = this.proc;
		if (!proc) return;
		const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
		const kill = setTimeout(() => proc.kill('SIGKILL'), 2000);
		this.request('engine.shutdown', {}, { timeoutMs: 2000 }).catch(() => {});
		proc.stdin.end();
		await exited;
		clearTimeout(kill);
	}
}

let shared: Promise<SlicerEngine | null> | null = null;

/**
 * Our engine if one is found (slicer/locate.ts) and it negotiates, else null (slicer.ts then slices
 * through the stock Bambu Studio command line). Shared by the whole server; the engine itself restarts
 * after a crash and stops when idle.
 */
export async function openSlicer(
	env: Record<string, string | undefined> = process.env
): Promise<SlicerEngine | null> {
	shared ??= (async () => {
		const found = locateEngine(env);
		if (!found) return null;
		try {
			return await StdioEngine.open({
				command: found.path,
				workDir: path.join(os.tmpdir(), `printlab-slicer-${process.pid}`),
				resourcesDir: found.resourcesDir
			});
		} catch (e) {
			console.warn(`Print Lab Slicer at ${found.path} did not start: ${(e as Error).message}`);
			return null;
		}
	})();
	const engine = await shared;
	if (!engine) shared = null;
	return engine;
}
