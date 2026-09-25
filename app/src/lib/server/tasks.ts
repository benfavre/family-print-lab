// Background tasks: long work runs here instead of inside a web request, so closing a dialog or a tab
// does not lose it. Every change is broadcast (the live event stream forwards it to all open tabs).
// Tasks live in memory: recent history survives until the app restarts, which is enough for work
// that takes seconds to minutes.
import { EventEmitter } from 'node:events';
import type { AiProviderId } from '$lib/shared/integrations';
import type { TaskInfo, TaskKind } from '$lib/shared/tasks';
import { AppError } from './validation';

export interface TaskContext {
	/** Reports progress ("Asking Claude…"). */
	stage(text: string): void;
	signal: AbortSignal;
	info: TaskInfo;
}

interface Entry {
	info: TaskInfo;
	abort: AbortController;
	onCancel?: () => void;
}

const KEEP = 60;

export class TaskCenter {
	readonly events = new EventEmitter();
	private tasks = new Map<string, Entry>();

	constructor() {
		this.events.setMaxListeners(100);
	}

	list(): TaskInfo[] {
		return [...this.tasks.values()]
			.map((e) => e.info)
			.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
	}

	get(id: string): TaskInfo {
		const entry = this.tasks.get(id);
		if (!entry)
			throw new AppError(404, 'That task is no longer known (the app may have restarted).');
		return entry.info;
	}

	/**
	 * Starts work in the background and returns its task at once. `run` gets a context for progress and
	 * cancellation; its result is merged into the task via `finish`.
	 */
	start<T>(
		meta: {
			kind: TaskKind;
			title: string;
			projectId?: string | null;
			modelId?: string | null;
			provider?: AiProviderId | null;
			stage?: string;
		},
		run: (ctx: TaskContext) => Promise<T>,
		finish: (result: T, info: TaskInfo) => Partial<TaskInfo> = () => ({})
	): TaskInfo {
		const info: TaskInfo = {
			id: crypto.randomUUID(),
			kind: meta.kind,
			title: meta.title.slice(0, 120),
			projectId: meta.projectId ?? null,
			modelId: meta.modelId ?? null,
			provider: meta.provider ?? null,
			status: 'running',
			stage: meta.stage ?? 'Starting…',
			startedAt: new Date().toISOString(),
			finishedAt: null,
			error: null,
			suggestion: null,
			usedBy: null,
			versionId: null
		};
		const entry: Entry = { info, abort: new AbortController() };
		this.tasks.set(info.id, entry);
		this.prune();
		this.emit(info);
		const ctx: TaskContext = {
			info,
			signal: entry.abort.signal,
			stage: (text) => {
				if (info.status !== 'running' || info.stage === text) return;
				info.stage = text;
				this.emit(info);
			}
		};
		void run(ctx).then(
			(result) => {
				if (info.status !== 'running') return;
				Object.assign(info, finish(result, info), {
					status: 'done',
					stage: 'Done',
					finishedAt: new Date().toISOString()
				});
				this.emit(info);
			},
			(error) => {
				if (info.status !== 'running') return;
				const cancelled = entry.abort.signal.aborted;
				Object.assign(info, {
					status: cancelled ? 'cancelled' : 'failed',
					stage: cancelled ? 'Stopped' : 'Failed',
					error: cancelled ? null : (error as Error).message || 'Something went wrong.',
					finishedAt: new Date().toISOString()
				});
				this.emit(info);
			}
		);
		return info;
	}

	/** Runs work as a task and waits for it (short jobs that the caller wants the result of). */
	async run<T>(
		meta: Parameters<TaskCenter['start']>[0],
		work: (ctx: TaskContext) => Promise<T>,
		finish?: (result: T, info: TaskInfo) => Partial<TaskInfo>
	): Promise<T> {
		let settle!: { ok: (v: T) => void; fail: (e: unknown) => void };
		const done = new Promise<T>((ok, fail) => (settle = { ok, fail }));
		this.start(
			meta,
			async (ctx) => {
				try {
					const value = await work(ctx);
					settle.ok(value);
					return value;
				} catch (error) {
					settle.fail(error);
					throw error;
				}
			},
			finish
		);
		return done;
	}

	/** Long-lived tasks (a Blender window) that end when something else says so. */
	open(meta: Parameters<TaskCenter['start']>[0], onCancel: () => void) {
		let end!: () => void;
		const ended = new Promise<void>((resolve) => (end = resolve));
		const info = this.start(meta, () => ended);
		const entry = this.tasks.get(info.id)!;
		entry.onCancel = onCancel;
		return {
			info,
			stage: (text: string) => {
				if (info.status === 'running' && info.stage !== text) {
					info.stage = text;
					this.emit(info);
				}
			},
			end
		};
	}

	cancel(id: string) {
		const entry = this.tasks.get(id);
		if (!entry) throw new AppError(404, 'That task is no longer known.');
		if (entry.info.status !== 'running') return entry.info;
		entry.abort.abort();
		entry.onCancel?.();
		Object.assign(entry.info, {
			status: 'cancelled',
			stage: 'Stopped',
			finishedAt: new Date().toISOString()
		});
		this.emit(entry.info);
		return entry.info;
	}

	/** Records that a suggestion was turned into something (so the tray stops offering it). */
	markUsed(id: string, usedBy: string) {
		const entry = this.tasks.get(id);
		if (!entry) return;
		entry.info.usedBy = usedBy;
		this.emit(entry.info);
	}

	dismiss(id: string) {
		const entry = this.tasks.get(id);
		if (entry && entry.info.status !== 'running') {
			this.tasks.delete(id);
			this.events.emit('removed', id);
		}
	}

	private emit(info: TaskInfo) {
		this.events.emit('task', { ...info });
	}

	/** Keeps every running task and the most recent finished ones. */
	private prune() {
		const finished = this.list().filter((t) => t.status !== 'running');
		for (const t of finished.slice(KEEP)) this.tasks.delete(t.id);
	}
}
