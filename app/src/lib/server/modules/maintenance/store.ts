// The maintenance tracker's data: tasks per printer, the log, the print-hours odometer, and the check
// that finds due tasks. Pure database work (the module wires it to the bus, timers and printers).
import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { DB } from '$lib/server/db';
import { jobs } from '$lib/server/db/tables/core';
import { printers } from '$lib/server/db/tables/printers';
import {
	maintenanceLog,
	maintenanceTasks,
	printersOdometer
} from '$lib/server/db/tables/maintenance';
import { AppError, parse } from '$lib/server/validation';
import { PRINTER_MODELS, type ModelCode } from '$lib/shared/printers/models';
import {
	byUrgency,
	dueInfo,
	nozzleTypeLabel,
	type MaintenanceLogEntry,
	type MaintenanceTask,
	type MaintenanceTaskView,
	type Odometer
} from '$lib/shared/maintenance';
import { amsTasks, defaultTasksFor, type DefaultTask } from './defaults';
import { baselineInput, doneInput, nozzleChangeInput, taskInput, taskPatch } from './validation';

const nowIso = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const round2 = (n: number) => Math.round(n * 100) / 100;

/** A task that has just become due (for the maintenance.due event). */
export interface DueTask {
	task: MaintenanceTask;
	printerName: string;
	by: 'hours' | 'days';
}

export class MaintenanceStore {
	constructor(
		private db: DB,
		private now: () => Date = () => new Date()
	) {}

	// ---------- Odometer ----------

	/** Print hours: the finished jobs' actual minutes on this printer, plus the baseline. */
	odometer(printerId: string): Odometer {
		const row = this.db
			.select({ minutes: sql<number | null>`sum(${jobs.actualMinutes})` })
			.from(jobs)
			.where(and(eq(jobs.printerId, printerId), isNotNull(jobs.actualMinutes)))
			.get();
		const jobHours = round2((row?.minutes ?? 0) / 60);
		const baselineHours = this.odometerRow(printerId)?.baselineHours ?? 0;
		return { jobHours, baselineHours, totalHours: round2(jobHours + baselineHours) };
	}

	setBaseline(printerId: string, input: unknown): Odometer {
		this.needPrinter(printerId);
		const { baselineHours } = parse(baselineInput, input);
		this.ensureOdometer(printerId);
		this.db
			.update(printersOdometer)
			.set({ baselineHours, updatedAt: nowIso() })
			.where(eq(printersOdometer.printerId, printerId))
			.run();
		return this.odometer(printerId);
	}

	private odometerRow(printerId: string) {
		return this.db
			.select()
			.from(printersOdometer)
			.where(eq(printersOdometer.printerId, printerId))
			.get();
	}

	private ensureOdometer(printerId: string) {
		this.db.insert(printersOdometer).values({ printerId }).onConflictDoNothing().run();
	}

	// ---------- Default tasks ----------

	/** Adds the model's default tasks once per printer (removed ones stay removed). Returns how many. */
	seedDefaults(printerId: string, model: ModelCode): number {
		this.ensureOdometer(printerId);
		if (this.odometerRow(printerId)?.seededAt) return 0;
		const m = PRINTER_MODELS[model];
		const list = m ? defaultTasksFor(m.code, m.series) : [];
		this.db.transaction((tx) => {
			this.insertDefaults(tx as unknown as DB, printerId, list);
			tx.update(printersOdometer)
				.set({ seededAt: nowIso() })
				.where(eq(printersOdometer.printerId, printerId))
				.run();
		});
		return list.length;
	}

	/** Adds the AMS tasks the first time the printer reports an AMS. Returns how many. */
	seedAms(printerId: string, units: { model: string }[]): number {
		if (!units.length) return 0;
		this.ensureOdometer(printerId);
		if (this.odometerRow(printerId)?.amsSeededAt) return 0;
		const list = amsTasks(units);
		this.db.transaction((tx) => {
			this.insertDefaults(tx as unknown as DB, printerId, list);
			tx.update(printersOdometer)
				.set({ amsSeededAt: nowIso() })
				.where(eq(printersOdometer.printerId, printerId))
				.run();
		});
		return list.length;
	}

	/** Whether the AMS tasks were already added (so callers can skip the check). */
	amsSeeded(printerId: string): boolean {
		return !!this.odometerRow(printerId)?.amsSeededAt;
	}

	private insertDefaults(db: DB, printerId: string, list: DefaultTask[]) {
		const hours = this.odometer(printerId).totalHours;
		const at = this.now().toISOString();
		const start = this.nextOrder(db, printerId);
		list.forEach((d, i) =>
			db
				.insert(maintenanceTasks)
				.values({
					id: uuid(),
					printerId,
					kind: d.kind,
					label: d.label,
					intervalHours: d.intervalHours,
					intervalDays: d.intervalDays,
					lastDoneAt: null,
					lastDoneHours: hours,
					notes: d.quote,
					source: d.source,
					sortOrder: start + i,
					createdAt: at,
					updatedAt: at
				})
				.run()
		);
	}

	private nextOrder(db: DB, printerId: string) {
		const row = db
			.select({ max: sql<number | null>`max(${maintenanceTasks.sortOrder})` })
			.from(maintenanceTasks)
			.where(eq(maintenanceTasks.printerId, printerId))
			.get();
		return (row?.max ?? -1) + 1;
	}

	// ---------- Tasks ----------

	tasks(printerId: string): MaintenanceTaskView[] {
		const hours = this.odometer(printerId).totalHours;
		const now = this.now();
		return this.rows(printerId)
			.map((t) => ({ ...t, due: dueInfo(t, hours, now) }))
			.sort(byUrgency);
	}

	private rows(printerId: string): MaintenanceTask[] {
		return this.db
			.select()
			.from(maintenanceTasks)
			.where(eq(maintenanceTasks.printerId, printerId))
			.orderBy(asc(maintenanceTasks.sortOrder))
			.all()
			.map(toTask);
	}

	private task(printerId: string, taskId: string) {
		const row = this.db
			.select()
			.from(maintenanceTasks)
			.where(and(eq(maintenanceTasks.id, taskId), eq(maintenanceTasks.printerId, printerId)))
			.get();
		if (!row) throw new AppError(404, 'That maintenance task no longer exists.');
		return row;
	}

	addTask(printerId: string, input: unknown): MaintenanceTask {
		this.needPrinter(printerId);
		const data = parse(taskInput, input);
		this.ensureOdometer(printerId);
		const id = uuid();
		const at = this.now().toISOString();
		this.db
			.insert(maintenanceTasks)
			.values({
				id,
				printerId,
				kind: 'custom',
				label: data.label,
				intervalHours: data.intervalHours,
				intervalDays: data.intervalDays,
				notes: data.notes,
				lastDoneAt: null,
				lastDoneHours: this.odometer(printerId).totalHours,
				sortOrder: this.nextOrder(this.db, printerId),
				createdAt: at,
				updatedAt: at
			})
			.run();
		return toTask(this.task(printerId, id));
	}

	/** Edits a task; a changed interval clears the reminder so it can fire again at the new point. */
	updateTask(printerId: string, taskId: string, input: unknown): MaintenanceTask {
		const before = this.task(printerId, taskId);
		const data = parse(taskPatch, input);
		const intervalChanged =
			(data.intervalHours !== undefined && data.intervalHours !== before.intervalHours) ||
			(data.intervalDays !== undefined && data.intervalDays !== before.intervalDays);
		this.db
			.update(maintenanceTasks)
			.set({
				...data,
				...(intervalChanged && { notifiedAt: null }),
				updatedAt: nowIso()
			})
			.where(eq(maintenanceTasks.id, taskId))
			.run();
		return toTask(this.task(printerId, taskId));
	}

	deleteTask(printerId: string, taskId: string) {
		this.task(printerId, taskId);
		this.db.delete(maintenanceTasks).where(eq(maintenanceTasks.id, taskId)).run();
	}

	/** Marks a task done now: resets both counters, clears the reminder and logs it. */
	markDone(printerId: string, taskId: string, input: unknown = {}): MaintenanceTask {
		const row = this.task(printerId, taskId);
		const { note } = parse(doneInput, input);
		const at = this.now().toISOString();
		const hours = this.odometer(printerId).totalHours;
		this.db.transaction((tx) => {
			tx.update(maintenanceTasks)
				.set({ lastDoneAt: at, lastDoneHours: hours, notifiedAt: null, updatedAt: at })
				.where(eq(maintenanceTasks.id, taskId))
				.run();
			tx.insert(maintenanceLog)
				.values({
					id: uuid(),
					taskId,
					printerId,
					kind: row.kind,
					label: row.label,
					doneAt: at,
					hoursAt: hours,
					note
				})
				.run();
		});
		return toTask(this.task(printerId, taskId));
	}

	// ---------- Log ----------

	log(printerId: string, limit = 50): MaintenanceLogEntry[] {
		return this.db
			.select()
			.from(maintenanceLog)
			.where(eq(maintenanceLog.printerId, printerId))
			.orderBy(desc(maintenanceLog.doneAt))
			.limit(limit)
			.all()
			.map((r) => ({
				id: r.id,
				taskId: r.taskId,
				kind: r.kind,
				label: r.label,
				doneAt: r.doneAt,
				hoursAt: r.hoursAt,
				note: r.note
			}));
	}

	/** Records a nozzle change in the log (sending it to the printer is the module's job). */
	logNozzleChange(printerId: string, input: unknown): MaintenanceLogEntry {
		this.needPrinter(printerId);
		const data = parse(nozzleChangeInput, input);
		const id = uuid();
		const label = `Nozzle changed to ${data.diameter} mm${data.type ? ` ${nozzleTypeLabel(data.type).toLowerCase()}` : ''}`;
		this.db
			.insert(maintenanceLog)
			.values({
				id,
				taskId: null,
				printerId,
				kind: 'nozzle',
				label,
				doneAt: this.now().toISOString(),
				hoursAt: this.odometer(printerId).totalHours,
				note: data.note
			})
			.run();
		return this.log(printerId).find((e) => e.id === id)!;
	}

	// ---------- Reminders ----------

	/**
	 * Finds tasks that are due and have not been announced since they were last done, marks them
	 * announced and returns them (each task once until it is done or its interval changes).
	 */
	collectDue(printerId?: string): DueTask[] {
		const list = this.db
			.select({ id: printers.id, name: printers.name })
			.from(printers)
			.where(printerId ? eq(printers.id, printerId) : undefined)
			.all();
		const out: DueTask[] = [];
		const at = this.now().toISOString();
		for (const p of list) {
			const hours = this.odometer(p.id).totalHours;
			const rows = this.db
				.select()
				.from(maintenanceTasks)
				.where(eq(maintenanceTasks.printerId, p.id))
				.orderBy(asc(maintenanceTasks.sortOrder))
				.all();
			for (const row of rows) {
				if (row.notifiedAt) continue;
				const task = toTask(row);
				const due = dueInfo(task, hours, this.now());
				if (due.state !== 'due' || !due.by) continue;
				this.db
					.update(maintenanceTasks)
					.set({ notifiedAt: at })
					.where(eq(maintenanceTasks.id, row.id))
					.run();
				out.push({ task, printerName: p.name, by: due.by });
			}
		}
		return out;
	}

	private needPrinter(printerId: string) {
		const row = this.db
			.select({ id: printers.id })
			.from(printers)
			.where(eq(printers.id, printerId))
			.get();
		if (!row) throw new AppError(404, 'That printer is not here any more.');
	}
}

function toTask(row: typeof maintenanceTasks.$inferSelect): MaintenanceTask {
	return {
		id: row.id,
		printerId: row.printerId,
		kind: row.kind,
		label: row.label,
		intervalHours: row.intervalHours,
		intervalDays: row.intervalDays,
		lastDoneAt: row.lastDoneAt,
		lastDoneHours: row.lastDoneHours,
		notes: row.notes,
		source: row.source,
		createdAt: row.createdAt
	};
}
