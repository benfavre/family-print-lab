// The print queue: items in the queue_items table, each printer's switches in queue_printer_state, and
// the dispatcher that starts the next job on a free printer. It runs a pass when a print ends, a
// printer comes online, trays change, the queue changes, and every 30 s. Sends go through
// printing.send with wake: true, which runs the beforeDispatch hooks (power) inside its own task; the
// queue never calls those hooks itself. An item stays `dispatching` until that task settles.
import crypto from 'node:crypto';
import { and, eq, inArray, isNull, max } from 'drizzle-orm';
import type { DB } from '../../db';
import { jobs, queueItems, queuePrinterState } from '../../db/schema';
import type { EventBus } from '../../events';
import type { Lab } from '../../lab';
import type { Hooks, LivePublisher } from '../../modules';
import type { SettingsStore } from '../../module-settings';
import type { PrinterManager } from '../../printer/manager';
import type { PrintFiles } from '../../printing';
import type { TaskCenter } from '../../tasks';
import { AppError, parse } from '../../validation';
import type { QueueService } from '../contracts';
import { decide, type Decision, type ItemFacts, type PrinterFacts } from './rules';
import { queueAdd, queuePatch, queuePrinterPatch, queueReorder } from './validation';
import { loadedSlots } from '$lib/shared/printing';
import { ACTIVE_PRINTER_STATES, type Job } from '$lib/shared/domain';
import type { TaskInfo } from '$lib/shared/tasks';
import { sameModel } from '$lib/shared/printers/models';
import {
	inQuietHours,
	type QueueItem,
	type QueueItemView,
	type QueueSettings,
	type QueueView
} from '$lib/shared/queue';

// Answers from PrintFiles.check that only mean "not right now": the next pass tries again.
const TRANSIENT = new Set([
	'Another print is being sent to this printer right now.',
	'This job is being sent right now.',
	'The printer is busy with another print.',
	'The printer is not connected.'
]);

export interface QueueDeps {
	db: DB;
	lab: Lab;
	bus: EventBus;
	printers: PrinterManager;
	printing: PrintFiles;
	tasks: TaskCenter;
	hooks: Hooks;
	live: LivePublisher;
	settings: SettingsStore<QueueSettings>;
	log: (message: string) => void;
	now?: () => Date;
}

type Row = typeof queueItems.$inferSelect;
type PrinterState = typeof queuePrinterState.$inferSelect;

export class Queue implements QueueService {
	private offs: (() => void)[] = [];
	private timer?: NodeJS.Timeout;
	private pending?: NodeJS.Timeout;
	/** Send task id → queue item id. */
	private watching = new Map<string, string>();
	private now: () => Date;

	constructor(private d: QueueDeps) {
		this.now = d.now ?? (() => new Date());
	}

	start() {
		const { bus } = this.d;
		this.recover();
		const ended = (e: { printerId: string }) => {
			this.setState(e.printerId, { plateClearNeeded: true });
			this.changed(e.printerId, 'plate');
		};
		this.offs.push(
			bus.on('print.finished', ended),
			bus.on('print.failed', ended),
			bus.on('print.cancelled', ended),
			bus.on('printer.online', () => this.schedule()),
			bus.on('ams.tray.changed', () => this.schedule())
		);
		const onTask = (info: TaskInfo) => this.settled(info);
		this.d.tasks.events.on('task', onTask);
		this.offs.push(() => this.d.tasks.events.off('task', onTask));
		const onRegistry = () => this.schedule();
		this.d.printers.on('changed', onRegistry);
		this.offs.push(() => this.d.printers.off('changed', onRegistry));
		this.timer = setInterval(() => this.schedule(), 30_000);
		this.timer.unref();
		this.schedule();
		return this;
	}

	stop() {
		for (const off of this.offs.splice(0)) off();
		clearInterval(this.timer);
		clearTimeout(this.pending);
	}

	// ---------- QueueService ----------

	enqueue(jobId: string, opts: { printerId?: string | null; notBefore?: string | null } = {}) {
		this.add({ jobId, ...opts });
	}

	nextFor(printerId: string): { jobId: string } | null {
		const model = this.d.printers.get(printerId)?.model.code;
		if (!model) return null;
		const open = this.list().items.filter(
			(i) =>
				(i.status === 'waiting' || (i.status === 'held' && i.reason !== null)) &&
				(!i.slicedFor || sameModel(i.slicedFor, model))
		);
		const next =
			open.find((i) => i.printerId === printerId) ?? open.find((i) => !i.printerId) ?? null;
		return next ? { jobId: next.jobId } : null;
	}

	// ---------- API ----------

	/** Adds a queued job (or moves it to the end of another column if it is already in the queue). */
	add(input: unknown): QueueItem {
		const o = parse(queueAdd, input);
		const job = this.job(o.jobId);
		if (job.status !== 'Queued') throw new AppError(409, 'Only a queued job can join the queue.');
		const printerId = o.printerId === undefined ? job.printerId : o.printerId;
		if (printerId) this.d.printers.require(printerId);
		const existing = this.row({ jobId: o.jobId });
		if (existing && (existing.status === 'dispatching' || existing.status === 'sent'))
			throw new AppError(409, 'This job is already on its way to a printer.');
		const position = this.endOf(printerId);
		const values = {
			printerId,
			position,
			notBefore: o.notBefore ?? null,
			requirePlateClear: o.requirePlateClear ?? this.d.settings.get().requirePlateClear,
			status: 'waiting' as const,
			reason: null,
			updatedAt: new Date().toISOString()
		};
		if (existing)
			this.d.db.update(queueItems).set(values).where(eq(queueItems.id, existing.id)).run();
		else
			this.d.db
				.insert(queueItems)
				.values({ id: crypto.randomUUID(), jobId: o.jobId, ...values })
				.run();
		this.changed(printerId, 'added');
		return this.toItem(this.row({ jobId: o.jobId })!);
	}

	update(id: string, input: unknown): QueueItem {
		const o = parse(queuePatch, input);
		const row = this.need(id);
		if (row.status === 'dispatching' || row.status === 'sent')
			throw new AppError(409, 'This job is already on its way to a printer.');
		const set: Partial<Row> = { updatedAt: new Date().toISOString() };
		if (o.printerId !== undefined && o.printerId !== row.printerId) {
			if (o.printerId) this.d.printers.require(o.printerId);
			set.printerId = o.printerId;
			set.position = this.endOf(o.printerId);
		}
		if (o.notBefore !== undefined) set.notBefore = o.notBefore;
		if (o.requirePlateClear !== undefined) set.requirePlateClear = o.requirePlateClear;
		// Holding is the person's choice (no reason); releasing also retries a failed send.
		if (o.hold === true) Object.assign(set, { status: 'held', reason: null });
		if (o.hold === false) Object.assign(set, { status: 'waiting', reason: null });
		this.d.db.update(queueItems).set(set).where(eq(queueItems.id, id)).run();
		this.changed(set.printerId ?? row.printerId, o.hold ? 'held' : 'updated');
		return this.toItem(this.need(id));
	}

	remove(id: string) {
		const row = this.need(id);
		if (row.status === 'dispatching')
			throw new AppError(409, 'This job is being sent right now; stop it in Activity instead.');
		this.d.db.delete(queueItems).where(eq(queueItems.id, id)).run();
		this.changed(row.printerId, 'removed');
	}

	/** Puts one column in the given order; items named from other columns move into it. */
	reorder(input: unknown) {
		const o = parse(queueReorder, input);
		if (o.printerId) this.d.printers.require(o.printerId);
		const rows = o.ids.length
			? this.d.db.select().from(queueItems).where(inArray(queueItems.id, o.ids)).all()
			: [];
		if (rows.length !== new Set(o.ids).size)
			throw new AppError(409, 'The queue changed meanwhile. Try again.');
		if (
			rows.some(
				(r) => r.printerId !== o.printerId && (r.status === 'dispatching' || r.status === 'sent')
			)
		)
			throw new AppError(409, 'A job on its way to a printer cannot move.');
		const at = new Date().toISOString();
		this.d.db.transaction((tx) => {
			o.ids.forEach((id, position) =>
				tx
					.update(queueItems)
					.set({ printerId: o.printerId, position, updatedAt: at })
					.where(eq(queueItems.id, id))
					.run()
			);
		});
		this.changed(o.printerId, 'reordered');
	}

	/** A printer's switches: auto start, pause, "plate is clear", "start next now". */
	printer(printerId: string, input: unknown) {
		const o = parse(queuePrinterPatch, input);
		this.d.printers.require(printerId);
		const change: Partial<PrinterState> = {};
		if (o.autoDispatch !== undefined) change.autoDispatch = o.autoDispatch;
		if (o.paused !== undefined) change.paused = o.paused;
		if (o.plateCleared) change.plateClearNeeded = false;
		this.setState(printerId, change);
		let started: string | null = null;
		if (o.startNext) {
			const d = this.pass(printerId);
			started = d.dispatch.find((x) => x.printerId === printerId)?.itemId ?? null;
			if (!started)
				throw new AppError(
					409,
					d.blocked[printerId] ?? 'Nothing in the queue can start on this printer yet.'
				);
		}
		this.changed(printerId, o.plateCleared ? 'plate-cleared' : 'printer');
		return { started };
	}

	/** Everything the queue page shows. */
	list(): QueueView {
		const { items, printers, jobsById } = this.facts();
		const decision = decide(printers, items, this.options());
		const rows = this.rows();
		const infos = this.d.printers.info();
		const now = this.now().getTime();
		return {
			items: rows.map((r) => this.view(r, jobsById.get(r.jobId), decision)),
			printers: this.d.printers.list().map((p) => {
				const st = this.state(p.id);
				const s = p.status().state;
				const busy = !!s && ACTIVE_PRINTER_STATES.has(s.gcodeState);
				return {
					printerId: p.id,
					name: infos.find((i) => i.id === p.id)?.name ?? p.name,
					model: p.model.code,
					autoDispatch: st.autoDispatch,
					plateClearNeeded: st.plateClearNeeded,
					paused: st.paused,
					blocked: decision.blocked[p.id] ?? null,
					busyUntil:
						busy && s?.remainingMinutes
							? new Date(now + s.remainingMinutes * 60_000).toISOString()
							: null
				};
			}),
			settings: this.d.settings.get(),
			quietNow: inQuietHours(this.now(), this.d.settings.get().quietHours)
		};
	}

	settings(input?: unknown): QueueSettings {
		if (input === undefined) return this.d.settings.get();
		const saved = this.d.settings.set(input);
		this.changed(null, 'settings');
		return saved;
	}

	// ---------- The dispatcher ----------

	/** Runs a pass soon (several triggers at once make one pass). */
	schedule() {
		if (this.pending) return;
		this.pending = setTimeout(() => {
			this.pending = undefined;
			try {
				this.pass();
			} catch (error) {
				this.d.log(`Queue pass failed: ${(error as Error).message}`);
			}
		}, 0);
	}

	/** One pass: drops, holds and sends. `manual`: a printer whose Start next was pressed. */
	pass(manual?: string): Decision {
		const { items, printers, jobsById } = this.facts();
		const decision = decide(printers, items, { ...this.options(), manual });
		const at = new Date().toISOString();
		const rows = new Map(this.rows().map((r) => [r.id, r]));
		let changed = false;
		for (const id of decision.drop) {
			this.d.db.delete(queueItems).where(eq(queueItems.id, id)).run();
			changed = true;
		}
		for (const h of decision.hold) this.hold(rows.get(h.itemId)!, h.reason, at);
		changed ||= decision.hold.length > 0;
		for (const x of decision.dispatch) {
			const row = rows.get(x.itemId)!;
			const job = jobsById.get(row.jobId)!;
			const opts = {
				printerId: x.printerId,
				plate: job.sliced?.plate,
				useAms: x.useAms,
				amsMapping: x.amsMapping,
				wake: true
			};
			const check = this.d.printing.check(row.jobId, opts);
			const problem = check.blocking[0] ?? check.warnings.join(' ');
			if (problem) {
				if (!TRANSIENT.has(problem)) {
					this.hold(row, problem, at);
					changed = true;
				} else decision.blocked[x.printerId] = problem;
				decision.dispatch = decision.dispatch.filter((y) => y !== x);
				continue;
			}
			let task: TaskInfo;
			try {
				task = this.d.printing.send(row.jobId, opts);
			} catch (error) {
				this.hold(row, (error as Error).message, at);
				decision.dispatch = decision.dispatch.filter((y) => y !== x);
				changed = true;
				continue;
			}
			this.watching.set(task.id, row.id);
			this.d.db
				.update(queueItems)
				.set({ status: 'dispatching', reason: null, printerId: x.printerId, updatedAt: at })
				.where(eq(queueItems.id, row.id))
				.run();
			this.d.bus.emit('queue.dispatched', {
				itemId: row.id,
				jobId: row.jobId,
				printerId: x.printerId,
				taskId: task.id
			});
			changed = true;
		}
		if (changed) this.announce(null, 'dispatcher');
		return decision;
	}

	private hold(row: Row, reason: string, at: string) {
		this.d.db
			.update(queueItems)
			.set({ status: 'held', reason, updatedAt: at })
			.where(eq(queueItems.id, row.id))
			.run();
		this.d.bus.emit('queue.held', {
			itemId: row.id,
			jobId: row.jobId,
			printerId: row.printerId,
			reason
		});
	}

	/** A send task the queue started has settled. */
	private settled(info: TaskInfo) {
		const id = this.watching.get(info.id);
		if (!id || info.status === 'running') return;
		this.watching.delete(info.id);
		const row = this.row({ id });
		if (!row) return;
		const failed = info.status !== 'done';
		this.d.db
			.update(queueItems)
			.set({
				status: failed ? 'failed' : 'sent',
				reason: failed ? (info.error ?? 'Sending was stopped.') : null,
				updatedAt: new Date().toISOString()
			})
			.where(eq(queueItems.id, id))
			.run();
		this.changed(row.printerId, failed ? 'failed' : 'sent');
	}

	/** Sends that were running when the app stopped: sent if the job is printing, else failed. */
	private recover() {
		const stuck = this.d.db
			.select()
			.from(queueItems)
			.where(eq(queueItems.status, 'dispatching'))
			.all();
		for (const row of stuck) {
			const printing = this.d.lab.getJob(row.jobId)?.status === 'Printing';
			this.d.db
				.update(queueItems)
				.set({
					status: printing ? 'sent' : 'failed',
					reason: printing ? null : 'The app stopped while this was being sent.'
				})
				.where(eq(queueItems.id, row.id))
				.run();
		}
	}

	// ---------- Facts for the rules ----------

	private options() {
		return {
			now: this.now(),
			quiet: this.d.settings.get().quietHours,
			canWake: this.d.hooks.beforeDispatch.size > 0
		};
	}

	private facts(): { items: ItemFacts[]; printers: PrinterFacts[]; jobsById: Map<string, Job> } {
		const rows = this.rows();
		const jobsById = new Map<string, Job>();
		for (const r of rows) {
			const job = this.d.lab.getJob(r.jobId);
			if (job) jobsById.set(job.id, job);
		}
		const list = this.d.printers.list();
		// A job still marked as printing on a printer keeps it busy even before the printer says so.
		const printingOn = new Set(
			list.length
				? this.d.db
						.select({ printerId: jobs.printerId })
						.from(jobs)
						.where(
							and(
								eq(jobs.status, 'Printing'),
								inArray(
									jobs.printerId,
									list.map((p) => p.id)
								)
							)
						)
						.all()
						.map((j) => j.printerId)
				: []
		);
		const sending = new Set(rows.filter((r) => r.status === 'dispatching').map((r) => r.printerId));
		const printers: PrinterFacts[] = list.map((p) => {
			const status = p.status();
			const s = status.state ?? null;
			const st = this.state(p.id);
			return {
				id: p.id,
				name: status.name ?? p.name,
				model: p.model.code,
				connected: !!status.connected,
				reported: !!s,
				busy: (!!s && ACTIVE_PRINTER_STATES.has(s.gcodeState)) || printingOn.has(p.id),
				developerModeOff: s?.developerMode === false,
				sending: sending.has(p.id),
				slots: s ? loadedSlots(s) : null,
				autoDispatch: st.autoDispatch,
				paused: st.paused,
				plateClearNeeded: st.plateClearNeeded
			};
		});
		const items: ItemFacts[] = rows.map((r) => {
			const job = jobsById.get(r.jobId);
			const plate = job?.sliced?.plates.find((p) => p.index === job.sliced!.plate);
			return {
				id: r.id,
				printerId: r.printerId,
				status: r.status,
				notBefore: r.notBefore,
				requirePlateClear: r.requirePlateClear,
				reason: r.reason,
				job: job
					? {
							status: job.status,
							sliced:
								job.sliced && plate
									? { printerModelId: job.sliced.printerModelId, filaments: plate.filaments }
									: null
						}
					: null
			};
		});
		return { items, printers, jobsById };
	}

	// ---------- Rows ----------

	private rows(): Row[] {
		return this.d.db
			.select()
			.from(queueItems)
			.orderBy(queueItems.position, queueItems.createdAt)
			.all();
	}

	private row(where: { id?: string; jobId?: string }): Row | undefined {
		return this.d.db
			.select()
			.from(queueItems)
			.where(where.id ? eq(queueItems.id, where.id) : eq(queueItems.jobId, where.jobId!))
			.get();
	}

	private need(id: string): Row {
		const row = this.row({ id });
		if (!row) throw new AppError(404, 'That job is no longer in the queue.');
		return row;
	}

	private job(id: string): Job {
		const job = this.d.lab.getJob(id);
		if (!job) throw new AppError(404, 'That print job no longer exists.');
		return job;
	}

	private endOf(printerId: string | null): number {
		const r = this.d.db
			.select({ top: max(queueItems.position) })
			.from(queueItems)
			.where(printerId ? eq(queueItems.printerId, printerId) : isNull(queueItems.printerId))
			.get();
		return (r?.top ?? -1) + 1;
	}

	/**
	 * A printer's switches (a row is made on first use). A printer whose last print ended (FINISH or
	 * FAILED) before anyone told the queue starts with "plate needs clearing": nobody said it is clear.
	 */
	private state(printerId: string): PrinterState {
		const row = this.d.db
			.select()
			.from(queuePrinterState)
			.where(eq(queuePrinterState.printerId, printerId))
			.get();
		if (row) return row;
		const gcode = this.d.printers.get(printerId)?.status().state?.gcodeState;
		const fresh = {
			printerId,
			autoDispatch: true,
			paused: false,
			plateClearNeeded: gcode === 'FINISH' || gcode === 'FAILED'
		};
		this.d.db.insert(queuePrinterState).values(fresh).onConflictDoNothing().run();
		return fresh;
	}

	private setState(printerId: string, change: Partial<PrinterState>) {
		this.state(printerId);
		if (Object.keys(change).length)
			this.d.db
				.update(queuePrinterState)
				.set(change)
				.where(eq(queuePrinterState.printerId, printerId))
				.run();
	}

	private toItem(r: Row): QueueItem {
		return { ...r };
	}

	private view(r: Row, job: Job | undefined, d: Decision): QueueItemView {
		const plate = job?.sliced?.plates.find((p) => p.index === job.sliced!.plate);
		const title = job
			? `${this.d.lab.projectTitle(job.projectId) ?? 'Print'} ${job.revision}`.trim()
			: 'Removed job';
		return {
			...r,
			title,
			minutes: plate?.minutes ?? job?.minutes ?? null,
			slicedFor: job?.sliced?.printerModelId ?? null,
			waitingFor: r.status === 'waiting' || r.status === 'held' ? (d.waiting[r.id] ?? null) : null
		};
	}

	/** Tells the bus and open tabs, then runs a pass. */
	private changed(printerId: string | null, reason: string) {
		this.announce(printerId, reason);
		this.schedule();
	}

	private announce(printerId: string | null, reason: string) {
		this.d.bus.emit('queue.changed', { printerId, reason });
		this.d.live.send('queue:changed', { reason });
	}
}
