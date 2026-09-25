import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { EventEmitter } from 'node:events';
import type { DB } from './db';
import {
	activity,
	checklistItems,
	jobs,
	meta,
	modelVersions,
	printRequests,
	sketches,
	models,
	profiles,
	projects,
	spools
} from './db/schema';
import {
	CATEGORIES,
	CONSUMING_JOB,
	FINISHED_JOB,
	PROJECT_STATUSES,
	type Category,
	STARTER_STEPS,
	type Activity,
	type ChecklistItem,
	type Job,
	type ModelSummary,
	type ModelVersionSummary,
	type JobStatus,
	type PrintRequest,
	type Profile,
	type Project,
	type ProjectStatus,
	type SlicedInfo,
	type Spool,
	type Workspace
} from '$lib/shared/domain';
import {
	AppError,
	checklistPatch,
	checklistReplace,
	jobInput,
	jobPatch,
	jobTransition,
	parse,
	printRequestInput,
	profileInput,
	profilePatch,
	requestDecision,
	projectBulk,
	projectInput,
	projectPatch,
	spoolInput,
	spoolPatch
} from './validation';

type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
const nowIso = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Status moves a job can make. Finished prints are printed again as a new job, not re-opened. */
const JOB_MOVES: Record<JobStatus, JobStatus[]> = {
	Queued: ['Printing', 'Cancelled'],
	Printing: ['Queued', 'Succeeded', 'Failed', 'Cancelled'],
	Succeeded: ['Failed'],
	Failed: ['Succeeded'],
	Cancelled: ['Queued']
};

export interface ChangeEvent {
	changeId: number;
	kind: string;
}

/**
 * The workspace service. All writes go through here: validated, transactional, versioned per row,
 * logged to the activity table, and announced on `events` ('change') for live clients.
 */
export class Lab {
	readonly events = new EventEmitter();

	constructor(readonly db: DB) {
		this.events.setMaxListeners(100);
	}

	// ---------- Reads ----------

	changeId(): number {
		return Number(this.db.select().from(meta).where(eq(meta.key, 'change_id')).get()?.value ?? 0);
	}

	snapshot(): Workspace {
		const db = this.db;
		const steps = db
			.select()
			.from(checklistItems)
			.orderBy(asc(checklistItems.projectId), asc(checklistItems.position))
			.all();
		const byProject = new Map<string, ChecklistItem[]>();
		for (const s of steps) {
			const list = byProject.get(s.projectId) ?? [];
			list.push({ id: s.id, text: s.text, done: s.done });
			byProject.set(s.projectId, list);
		}
		return {
			profiles: db.select().from(profiles).orderBy(asc(profiles.createdAt)).all() as Profile[],
			projects: db
				.select()
				.from(projects)
				.orderBy(asc(projects.createdAt), asc(projects.id))
				.all()
				.map((p) => ({ ...p, checklist: byProject.get(p.id) ?? [] })) as Project[],
			jobs: db.select().from(jobs).orderBy(desc(jobs.createdAt)).all() as Job[],
			spools: db.select().from(spools).orderBy(asc(spools.createdAt)).all() as Spool[],
			activity: db
				.select()
				.from(activity)
				.orderBy(desc(activity.id))
				.limit(1000)
				.all() as Activity[],
			models: this.models(),
			sketches: this.db
				.select({
					id: sketches.id,
					projectId: sketches.projectId,
					title: sketches.title,
					width: sketches.width,
					height: sketches.height,
					version: sketches.version,
					createdAt: sketches.createdAt,
					updatedAt: sketches.updatedAt
				})
				.from(sketches)
				.orderBy(desc(sketches.createdAt))
				.all(),
			printRequests: db
				.select()
				.from(printRequests)
				.orderBy(desc(printRequests.createdAt))
				.all() as PrintRequest[],
			parentPin: this.hasParentPin(),
			changeId: this.changeId()
		};
	}

	/** Model metadata for the live workspace (sources and parameters are loaded by the editor on demand). */
	private models(): ModelSummary[] {
		const versions = this.db
			.select({
				id: modelVersions.id,
				modelId: modelVersions.modelId,
				number: modelVersions.number,
				note: modelVersions.note,
				origin: modelVersions.origin,
				triangles: modelVersions.triangles,
				sizeX: modelVersions.sizeX,
				sizeY: modelVersions.sizeY,
				sizeZ: modelVersions.sizeZ,
				volume: modelVersions.volume,
				hasThumbnail: modelVersions.hasThumbnail,
				createdAt: modelVersions.createdAt
			})
			.from(modelVersions)
			.orderBy(desc(modelVersions.number))
			.all();
		const byModel = new Map<string, ModelVersionSummary[]>();
		for (const { modelId, ...v } of versions)
			byModel.set(modelId, [...(byModel.get(modelId) ?? []), v]);
		return this.db
			.select()
			.from(models)
			.orderBy(asc(models.createdAt))
			.all()
			.map((m) => ({ ...m, versions: byModel.get(m.id) ?? [] }));
	}

	/** Records a change made outside this class (e.g. model files), so live clients refresh. */
	touch(kind: string, message?: string, projectId: string | null = null) {
		this.write(kind, (tx) => {
			if (message) this.log(tx, kind, message, projectId);
		});
	}

	// ---------- Write plumbing ----------

	private write<T>(kind: string, fn: (tx: Tx) => T): T {
		const result = this.db.transaction((tx) => {
			const value = fn(tx);
			tx.insert(meta)
				.values({ key: 'change_id', value: '1' })
				.onConflictDoUpdate({
					target: meta.key,
					set: { value: sql`CAST(${meta.value} AS INTEGER) + 1` }
				})
				.run();
			return value;
		});
		this.events.emit('change', { changeId: this.changeId(), kind } satisfies ChangeEvent);
		return result;
	}

	private log(
		tx: Tx,
		kind: string,
		message: string,
		projectId: string | null = null,
		jobId: string | null = null
	) {
		tx.insert(activity).values({ kind, message, projectId, jobId, at: nowIso() }).run();
	}

	/** Updates a row only if its version matches; distinguishes "gone" from "changed elsewhere". */
	private versioned<
		T extends typeof profiles | typeof projects | typeof spools | typeof jobs | typeof printRequests
	>(
		tx: Tx,
		table: T,
		id: string,
		expected: number,
		values: Record<string, unknown>,
		label: string
	) {
		const result = tx
			.update(table)
			.set({ ...values, version: sql`${table.version} + 1`, updatedAt: nowIso() } as never)
			.where(and(eq(table.id, id), eq(table.version, expected)))
			.run();
		if (result.changes === 0) {
			const exists = tx.select({ id: table.id }).from(table).where(eq(table.id, id)).get();
			throw exists
				? new AppError(409, `This ${label} was changed somewhere else. Reload it and try again.`)
				: new AppError(404, `That ${label} no longer exists.`);
		}
	}

	private need<T>(value: T | undefined, label: string): T {
		if (value === undefined) throw new AppError(404, `That ${label} no longer exists.`);
		return value;
	}

	private job(tx: Tx, id: string) {
		return this.need(
			tx.select().from(jobs).where(eq(jobs.id, id)).get() as Job | undefined,
			'print job'
		);
	}
	private project(tx: Tx, id: string) {
		return this.need(tx.select().from(projects).where(eq(projects.id, id)).get(), 'project');
	}

	// ---------- Profiles ----------

	/** Whether a parent PIN is set (see kid/pin.ts); kid mode needs one. */
	hasParentPin() {
		return !!this.db.select().from(meta).where(eq(meta.key, 'parent_pin')).get();
	}

	private needPinForKid(kid: unknown) {
		if (kid && !this.hasParentPin())
			throw new AppError(409, 'Set a parent PIN first, so only grown-ups can leave kid mode.');
	}

	createProfile(input: unknown) {
		const data = parse(profileInput, input);
		this.needPinForKid(data.kid);
		const id = uuid();
		return this.write('profile', (tx) => {
			tx.insert(profiles)
				.values({ id, ...data })
				.run();
			this.log(tx, 'profile', `Added ${data.name} to the family`);
			return id;
		});
	}

	updateProfile(id: string, input: unknown) {
		const { version, ...data } = parse(profilePatch, input);
		this.needPinForKid(data.kid);
		this.write('profile', (tx) => this.versioned(tx, profiles, id, version, data, 'profile'));
	}

	deleteProfile(id: string) {
		this.write('profile', (tx) => {
			const owned = tx
				.select({ id: projects.id })
				.from(projects)
				.where(eq(projects.profileId, id))
				.all();
			if (owned.length)
				throw new AppError(
					409,
					'Reassign or delete this person’s projects before removing their profile.'
				);
			if (tx.delete(profiles).where(eq(profiles.id, id)).run().changes === 0)
				throw new AppError(404, 'That profile no longer exists.');
		});
	}

	// ---------- Projects ----------

	createProject(input: unknown) {
		const { checklist, ...data } = parse(projectInput, input);
		const id = uuid();
		return this.write('project', (tx) => {
			this.need(
				tx.select().from(profiles).where(eq(profiles.id, data.profileId)).get(),
				'family member'
			);
			tx.insert(projects)
				.values({ id, ...data })
				.run();
			const steps = checklist ?? STARTER_STEPS.map((text) => ({ text, done: false }));
			if (steps.length)
				tx.insert(checklistItems)
					.values(
						steps.map((s, position) => ({
							id: uuid(),
							projectId: id,
							text: s.text,
							done: s.done,
							position
						}))
					)
					.run();
			this.log(tx, 'project', `Added “${data.title}”`, id);
			return id;
		});
	}

	updateProject(id: string, input: unknown) {
		const { version, ...data } = parse(projectPatch, input);
		this.write('project', (tx) => {
			if (data.profileId)
				this.need(
					tx.select().from(profiles).where(eq(profiles.id, data.profileId)).get(),
					'family member'
				);
			const before = this.project(tx, id);
			this.versioned(tx, projects, id, version, data, 'project');
			if (data.status && data.status !== before.status)
				this.log(tx, 'status', `Moved to ${data.status}`, id);
		});
	}

	/** Unversioned quick actions (pin, status) — last write wins, which is what a toggle should do. */
	setPinned(id: string, pinned: boolean) {
		this.write('project', (tx) => {
			this.project(tx, id);
			tx.update(projects)
				.set({ pinned, version: sql`${projects.version} + 1` })
				.where(eq(projects.id, id))
				.run();
		});
	}

	setProjectStatus(id: string, status: ProjectStatus) {
		this.write('project', (tx) => this.statusIn(tx, id, status));
	}
	private statusIn(tx: Tx, id: string, status: ProjectStatus) {
		const before = this.project(tx, id);
		if (before.status === status) return;
		tx.update(projects)
			.set({ status, updatedAt: nowIso(), version: sql`${projects.version} + 1` })
			.where(eq(projects.id, id))
			.run();
		this.log(tx, 'status', `Moved to ${status}`, id);
	}

	deleteProject(id: string) {
		this.write('project', (tx) => this.deleteIn(tx, id));
	}
	private deleteIn(tx: Tx, id: string) {
		const project = this.project(tx, id);
		for (const job of tx.select().from(jobs).where(eq(jobs.projectId, id)).all() as Job[])
			this.refund(tx, job);
		tx.delete(projects).where(eq(projects.id, id)).run();
		this.log(tx, 'project', `Deleted “${project.title}”`);
	}

	duplicateProject(id: string) {
		return this.write('project', (tx) => this.duplicateIn(tx, id));
	}
	private duplicateIn(tx: Tx, id: string) {
		const newId = uuid();
		{
			const source = this.project(tx, id);
			const title = `${source.title} (copy)`.slice(0, 80);
			tx.insert(projects)
				.values({
					...source,
					id: newId,
					title,
					status: 'Idea',
					pinned: false,
					version: 1,
					createdAt: nowIso(),
					updatedAt: nowIso()
				})
				.run();
			const steps = tx
				.select()
				.from(checklistItems)
				.where(eq(checklistItems.projectId, id))
				.orderBy(asc(checklistItems.position))
				.all();
			if (steps.length)
				tx.insert(checklistItems)
					.values(steps.map((s) => ({ ...s, id: uuid(), projectId: newId, done: false })))
					.run();
			this.log(tx, 'project', `Duplicated from “${source.title}”`, newId);
		}
		return newId;
	}

	/**
	 * One change applied to many projects in a single transaction: either every project changes or none
	 * does (a project deleted in another tab fails the whole batch with a 404).
	 */
	bulkProjects(input: unknown): { count: number; created: string[] } {
		const { ids, action, value } = parse(projectBulk, input);
		const unique = [...new Set(ids)];
		return this.write('project', (tx) => {
			const rows = unique.map((id) => this.project(tx, id));
			const created: string[] = [];
			const set = (values: Record<string, unknown>) => {
				for (const id of unique)
					tx.update(projects)
						.set({ ...values, updatedAt: nowIso(), version: sql`${projects.version} + 1` } as never)
						.where(eq(projects.id, id))
						.run();
			};
			switch (action) {
				case 'status':
					if (!PROJECT_STATUSES.includes(value as ProjectStatus))
						throw new AppError(400, 'Choose a progress stage.');
					for (const id of unique) this.statusIn(tx, id, value as ProjectStatus);
					break;
				case 'owner': {
					const owner = tx
						.select()
						.from(profiles)
						.where(eq(profiles.id, value ?? ''))
						.get();
					if (!owner) throw new AppError(404, 'That person no longer exists.');
					set({ profileId: owner.id });
					this.log(tx, 'project', `${unique.length} projects moved to ${owner.name}`);
					break;
				}
				case 'category':
					if (!CATEGORIES.includes(value as Category))
						throw new AppError(400, 'Choose a category.');
					set({ category: value });
					break;
				case 'pin':
				case 'unpin':
					for (const id of unique)
						tx.update(projects)
							.set({ pinned: action === 'pin', version: sql`${projects.version} + 1` })
							.where(eq(projects.id, id))
							.run();
					break;
				case 'duplicate':
					for (const id of unique) created.push(this.duplicateIn(tx, id));
					break;
				case 'delete':
					for (const id of unique) this.deleteIn(tx, id);
					break;
			}
			return { count: rows.length, created };
		});
	}

	// ---------- Checklist ----------

	addStep(projectId: string, text: unknown) {
		const step = parse(checklistPatch.required({ text: true }), { text });
		return this.write('checklist', (tx) => {
			this.project(tx, projectId);
			const last = tx
				.select({ p: sql<number>`coalesce(max(${checklistItems.position}), -1)` })
				.from(checklistItems)
				.where(eq(checklistItems.projectId, projectId))
				.get();
			const id = uuid();
			tx.insert(checklistItems)
				.values({ id, projectId, text: step.text, done: false, position: (last?.p ?? -1) + 1 })
				.run();
			return id;
		});
	}

	updateStep(projectId: string, stepId: string, input: unknown) {
		const data = parse(checklistPatch, input);
		this.write('checklist', (tx) => {
			const result = tx
				.update(checklistItems)
				.set(data)
				.where(and(eq(checklistItems.id, stepId), eq(checklistItems.projectId, projectId)))
				.run();
			if (!result.changes) throw new AppError(404, 'That checklist step no longer exists.');
			if (data.done)
				this.log(
					tx,
					'checklist',
					`Checked “${tx.select().from(checklistItems).where(eq(checklistItems.id, stepId)).get()?.text}”`,
					projectId
				);
		});
	}

	removeStep(projectId: string, stepId: string) {
		this.write('checklist', (tx) => {
			tx.delete(checklistItems)
				.where(and(eq(checklistItems.id, stepId), eq(checklistItems.projectId, projectId)))
				.run();
		});
	}

	/** Replaces or extends a checklist, keeping the done state of steps whose text is unchanged. */
	setChecklist(projectId: string, input: unknown) {
		const { steps, mode } = parse(checklistReplace, input);
		this.write('checklist', (tx) => {
			this.project(tx, projectId);
			const current = tx
				.select()
				.from(checklistItems)
				.where(eq(checklistItems.projectId, projectId))
				.orderBy(asc(checklistItems.position))
				.all();
			const known = new Map(current.map((c) => [c.text.toLowerCase(), c]));
			const next =
				mode === 'replace'
					? steps.map((text) => ({ text, done: known.get(text.toLowerCase())?.done ?? false }))
					: [
							...current.map((c) => ({ text: c.text, done: c.done })),
							...steps
								.filter((t) => !known.has(t.toLowerCase()))
								.map((text) => ({ text, done: false }))
						];
			tx.delete(checklistItems).where(eq(checklistItems.projectId, projectId)).run();
			const rows = next
				.slice(0, 60)
				.map((s, position) => ({ id: uuid(), projectId, text: s.text, done: s.done, position }));
			if (rows.length) tx.insert(checklistItems).values(rows).run();
		});
	}

	// ---------- Spools ----------

	createSpool(input: unknown) {
		const data = parse(spoolInput, input);
		const id = uuid();
		return this.write('spool', (tx) => {
			tx.insert(spools)
				.values({ id, ...data })
				.run();
			this.log(
				tx,
				'spool',
				`Added ${data.colorName || data.colorHex} ${data.material} to the shelf`
			);
			return id;
		});
	}

	updateSpool(id: string, input: unknown) {
		const { version, ...data } = parse(spoolPatch, input);
		this.write('spool', (tx) => {
			const before = this.need(tx.select().from(spools).where(eq(spools.id, id)).get(), 'spool');
			const total = data.totalGrams ?? before.totalGrams;
			if ((data.remainingGrams ?? before.remainingGrams) > total)
				throw new AppError(400, 'Remaining weight cannot exceed the spool size.');
			this.versioned(tx, spools, id, version, data, 'spool');
			// A hand-entered weight is a new baseline: earlier charges stay recorded but are no longer refundable.
			if (
				(data.remainingGrams !== undefined && data.remainingGrams !== before.remainingGrams) ||
				(data.totalGrams !== undefined && data.totalGrams !== before.totalGrams)
			)
				tx.update(jobs).set({ chargeGrams: 0 }).where(eq(jobs.chargeSpoolId, id)).run();
		});
	}

	deleteSpool(id: string) {
		this.write('spool', (tx) => {
			tx.update(jobs).set({ chargeGrams: 0 }).where(eq(jobs.chargeSpoolId, id)).run();
			if (tx.delete(spools).where(eq(spools.id, id)).run().changes === 0)
				throw new AppError(404, 'That spool no longer exists.');
		});
	}

	// ---------- Jobs and filament accounting ----------

	/** Returns filament this job was charged to its spool. */
	private refund(tx: Tx, job: Job) {
		if (job.chargeSpoolId && job.chargeGrams > 0) {
			tx.update(spools)
				.set({
					remainingGrams: sql`min(${spools.totalGrams}, ${spools.remainingGrams} + ${job.chargeGrams})`,
					version: sql`${spools.version} + 1`
				})
				.where(eq(spools.id, job.chargeSpoolId))
				.run();
		}
		job.chargeSpoolId = null;
		job.chargeGrams = 0;
	}

	/** Refunds any previous charge, then charges finished (succeeded or failed) prints to their spool. */
	private settle(tx: Tx, job: Job) {
		const consumes = !!job.spoolId && CONSUMING_JOB.has(job.status) && (job.grams ?? 0) > 0;
		// Linked to its spool with nothing refundable: the spool was weighed by hand since (a new
		// baseline that already includes this print) or was empty. Charging again would count it twice.
		if (consumes && job.chargeSpoolId === job.spoolId && job.chargeGrams === 0) return;
		this.refund(tx, job);
		if (job.spoolId && CONSUMING_JOB.has(job.status) && (job.grams ?? 0) > 0) {
			const spool = tx.select().from(spools).where(eq(spools.id, job.spoolId)).get();
			if (spool) {
				const charged = Math.min(job.grams ?? 0, spool.remainingGrams);
				tx.update(spools)
					.set({
						remainingGrams: round1(spool.remainingGrams - charged),
						version: sql`${spools.version} + 1`
					})
					.where(eq(spools.id, spool.id))
					.run();
				job.chargeSpoolId = spool.id;
				job.chargeGrams = charged;
			}
		}
		tx.update(jobs)
			.set({ chargeSpoolId: job.chargeSpoolId, chargeGrams: job.chargeGrams })
			.where(eq(jobs.id, job.id))
			.run();
	}

	private nudgeProject(tx: Tx, projectId: string, jobStatus: JobStatus): boolean {
		const project = this.project(tx, projectId);
		let next: ProjectStatus | null = null;
		if (jobStatus === 'Printing' && (project.status === 'Idea' || project.status === 'Planned'))
			next = 'Printing';
		if (jobStatus === 'Succeeded' && project.status === 'Printing') {
			const open = tx
				.select({ id: jobs.id })
				.from(jobs)
				.where(and(eq(jobs.projectId, projectId), inArray(jobs.status, ['Queued', 'Printing'])))
				.all();
			if (!open.length) next = 'Done';
		}
		if (!next) return false;
		tx.update(projects)
			.set({ status: next, updatedAt: nowIso(), version: sql`${projects.version} + 1` })
			.where(eq(projects.id, projectId))
			.run();
		this.log(tx, 'status', `Moved to ${next}`, projectId);
		return next === 'Done';
	}

	createJob(input: unknown) {
		const data = parse(jobInput, input);
		const id = uuid();
		return this.write('job', (tx) => {
			this.project(tx, data.projectId);
			if (data.spoolId)
				this.need(tx.select().from(spools).where(eq(spools.id, data.spoolId)).get(), 'spool');
			// Next free vNN, so deleting a job never makes two plates share a label.
			const count = tx
				.select({ revision: jobs.revision })
				.from(jobs)
				.where(eq(jobs.projectId, data.projectId))
				.all()
				.reduce((max, j) => Math.max(max, Number(j.revision.match(/^v(\d+)$/)?.[1] ?? 0)), 0);
			const status = data.status ?? 'Queued';
			const at = nowIso();
			const row = {
				id,
				revision: `v${String(count + 1).padStart(2, '0')}`,
				supports: 'None' as const,
				...data,
				status,
				startedAt:
					data.startedAt ?? (status === 'Printing' || FINISHED_JOB.has(status) ? at : null),
				finishedAt: FINISHED_JOB.has(status) ? (data.finishedAt ?? at) : null
			};
			tx.insert(jobs).values(row).run();
			const job = this.job(tx, id);
			this.settle(tx, job);
			this.nudgeProject(tx, job.projectId, status);
			this.log(tx, 'job', `Queued ${job.revision}`, job.projectId, id);
			return id;
		});
	}

	updateJob(id: string, input: unknown) {
		const { version, ...data } = parse(jobPatch, input);
		this.write('job', (tx) => {
			if (data.projectId) this.project(tx, data.projectId);
			if (data.spoolId)
				this.need(tx.select().from(spools).where(eq(spools.id, data.spoolId)).get(), 'spool');
			const before = this.job(tx, id);
			const status = data.status ?? before.status;
			const at = nowIso();
			const patch: Record<string, unknown> = { ...data };
			if (status === 'Printing' && !(data.startedAt ?? before.startedAt)) patch.startedAt = at;
			if (status === 'Queued' || status === 'Printing') patch.finishedAt = null;
			else if (!(data.finishedAt ?? before.finishedAt)) patch.finishedAt = at;
			this.versioned(tx, jobs, id, version, patch, 'print job');
			const job = this.job(tx, id);
			this.settle(tx, job);
			if (status !== before.status) {
				this.nudgeProject(tx, job.projectId, status);
				this.log(tx, 'job', `${job.revision || 'Print'}: ${status}`, job.projectId, id);
			}
		});
	}

	/** Start / succeed / fail / cancel a job, keeping project status and spool stock in step. */
	transitionJob(id: string, input: unknown) {
		const { to, printerTask, from } = parse(jobTransition, input);
		return this.write('job', (tx) => {
			const job = this.job(tx, id);
			// A tab that has not caught up must not undo what happened since (e.g. cancel a finished print).
			if (from && job.status !== from)
				throw new AppError(409, `This job is already ${job.status.toLowerCase()}.`);
			if (!JOB_MOVES[job.status].includes(to))
				throw new AppError(
					409,
					job.status === to
						? `This job is already ${to.toLowerCase()}.`
						: `A ${job.status.toLowerCase()} job cannot become ${to.toLowerCase()}; print it again instead.`
				);
			return this.applyTransition(tx, id, to, printerTask);
		});
	}

	/** One job, straight from its row (cheaper than a workspace snapshot). */
	getJob(id: string): Job | undefined {
		return this.db.select().from(jobs).where(eq(jobs.id, id)).get() as Job | undefined;
	}

	/** A project's title, straight from its row. */
	projectTitle(id: string): string | undefined {
		return this.db.select({ title: projects.title }).from(projects).where(eq(projects.id, id)).get()
			?.title;
	}

	private applyTransition(tx: Tx, id: string, to: JobStatus, printerTask?: string) {
		const job = this.job(tx, id);
		const at = nowIso();
		const patch: Partial<Job> = { status: to };
		if (printerTask !== undefined) patch.printerTask = printerTask;
		if (to === 'Printing') {
			patch.startedAt = at;
			patch.finishedAt = null;
		} else if (to !== 'Queued') {
			patch.finishedAt = at;
			if (to !== 'Cancelled' && job.startedAt && job.actualMinutes === null)
				patch.actualMinutes = Math.max(
					1,
					Math.round((Date.parse(at) - Date.parse(job.startedAt)) / 60000)
				);
		}
		tx.update(jobs)
			.set({ ...patch, updatedAt: at, version: sql`${jobs.version} + 1` })
			.where(eq(jobs.id, id))
			.run();
		const updated = this.job(tx, id);
		this.settle(tx, updated);
		const autoDone = this.nudgeProject(tx, updated.projectId, to);
		const verb = {
			Queued: 'Re-queued',
			Printing: 'Started',
			Succeeded: 'Succeeded',
			Failed: 'Failed',
			Cancelled: 'Cancelled'
		}[to];
		this.log(
			tx,
			'job',
			`${verb} ${updated.revision || 'print'}${printerTask ? ` (printer task “${printerTask}”)` : ''}`,
			updated.projectId,
			id
		);
		return { autoDone };
	}

	reprintJob(id: string, overrides: Record<string, unknown> = {}) {
		const source = this.db.select().from(jobs).where(eq(jobs.id, id)).get() as Job | undefined;
		if (!source) throw new AppError(404, 'That print job no longer exists.');
		const {
			projectId,
			spoolId,
			material,
			grams,
			minutes,
			layerHeight,
			nozzle,
			plate,
			supports,
			infill,
			sliced
		} = source;
		const id2 = this.createJob({
			projectId,
			spoolId,
			material,
			grams,
			minutes,
			layerHeight,
			nozzle,
			plate,
			supports,
			infill,
			...overrides,
			status: 'Queued'
		});
		// The same sliced file prints again as-is.
		if (sliced && !('sliced' in overrides)) this.setJobSliced(id2, sliced);
		return id2;
	}

	/**
	 * Attaches (or with null, removes) a sliced print file. The job's time and filament estimates follow
	 * the slicer's figures for the chosen plate unless someone typed their own.
	 */
	setJobSliced(id: string, sliced: SlicedInfo | null) {
		this.write('job', (tx) => {
			const job = this.job(tx, id);
			if (job.status !== 'Queued' && sliced)
				throw new AppError(409, 'Only a queued job can take a new sliced file.');
			const plate = sliced?.plates.find((p) => p.index === sliced.plate);
			const patch: Partial<Job> = { sliced };
			if (plate) {
				if (job.minutes === null || job.sliced) patch.minutes = plate.minutes;
				if (job.grams === null || job.sliced) patch.grams = plate.grams;
				if (!job.material && plate.filaments[0]) patch.material = plate.filaments[0].type;
				if (plate.supports && job.supports === 'None') patch.supports = 'Normal';
			}
			tx.update(jobs)
				.set({ ...patch, updatedAt: nowIso(), version: sql`${jobs.version} + 1` })
				.where(eq(jobs.id, id))
				.run();
			this.log(
				tx,
				'job',
				sliced
					? `${job.revision || 'Print'}: sliced file “${sliced.name}” attached`
					: `${job.revision || 'Print'}: sliced file removed`,
				job.projectId,
				id
			);
		});
	}

	/** Sliced files any job still refers to (the rest can be deleted). */
	slicedFilesInUse(): Set<string> {
		const rows = this.db.select({ sliced: jobs.sliced }).from(jobs).all();
		return new Set(rows.map((r) => r.sliced?.file).filter((f): f is string => !!f));
	}

	deleteJob(id: string) {
		this.write('job', (tx) => {
			const job = this.job(tx, id);
			this.refund(tx, job);
			tx.delete(jobs).where(eq(jobs.id, id)).run();
			this.log(tx, 'job', `Deleted ${job.revision || 'a print job'}`, job.projectId);
		});
	}

	// ---------- Printer automation ----------

	/** When the printer starts a task and exactly one Printing job is unlinked, link them. */
	linkStartedTask(task: string) {
		if (!task) return null;
		const running = this.db.select().from(jobs).where(eq(jobs.status, 'Printing')).all();
		if (running.some((j) => j.printerTask === task)) return null;
		const unlinked = running.filter((j) => !j.printerTask);
		if (unlinked.length !== 1) return null;
		const job = unlinked[0];
		this.write('job', (tx) => {
			tx.update(jobs)
				.set({ printerTask: task, version: sql`${jobs.version} + 1` })
				.where(eq(jobs.id, job.id))
				.run();
			this.log(tx, 'printer', `Linked to printer task “${task}”`, job.projectId, job.id);
		});
		return job.id;
	}

	/** Closes the job linked to a printer task when the printer reports the outcome. */
	closePrinterTask(task: string, ok: boolean) {
		const job = this.db
			.select()
			.from(jobs)
			.where(and(eq(jobs.status, 'Printing'), eq(jobs.printerTask, task)))
			.get();
		if (!task || !job) return null;
		this.write('job', (tx) => {
			this.applyTransition(tx, job.id, ok ? 'Succeeded' : 'Failed');
			if (!ok && !job.notes)
				tx.update(jobs)
					.set({ notes: 'The printer reported this print as failed.' })
					.where(eq(jobs.id, job.id))
					.run();
		});
		return job.id;
	}

	// ---------- Kid mode: print requests ----------

	/** A child asks a grown-up to print the current version of something they made. */
	requestPrint(profileId: string, projectId: string, input: unknown) {
		const data = parse(printRequestInput, input);
		return this.write('request', (tx) => {
			const project = this.project(tx, projectId);
			if (project.profileId !== profileId)
				throw new AppError(404, 'That project no longer exists.');
			const model = tx
				.select()
				.from(models)
				.where(eq(models.projectId, projectId))
				.orderBy(desc(models.createdAt))
				.get();
			if (!model?.currentVersionId) throw new AppError(409, 'Make it first, then ask to print it.');
			if (data.spoolId)
				this.need(tx.select().from(spools).where(eq(spools.id, data.spoolId)).get(), 'spool');
			const waiting = tx
				.select({ id: printRequests.id })
				.from(printRequests)
				.where(and(eq(printRequests.projectId, projectId), eq(printRequests.status, 'Waiting')))
				.get();
			if (waiting) throw new AppError(409, 'You already asked! A grown-up will look soon.');
			const id = uuid();
			tx.insert(printRequests)
				.values({ id, projectId, profileId, modelVersionId: model.currentVersionId, ...data })
				.run();
			const who = tx.select().from(profiles).where(eq(profiles.id, profileId)).get();
			this.log(
				tx,
				'request',
				`${who?.name ?? 'A kid'} asked to print “${project.title}”`,
				projectId
			);
			return id;
		});
	}

	/** A grown-up approves (queuing a print job for the exact version) or declines a request. */
	decideRequest(id: string, input: unknown) {
		const { decision, reply, version } = parse(requestDecision, input);
		return this.write('request', (tx) => {
			const request = this.need(
				tx.select().from(printRequests).where(eq(printRequests.id, id)).get(),
				'print request'
			);
			if (request.status !== 'Waiting')
				throw new AppError(409, 'This request was already answered.');
			const project = this.project(tx, request.projectId);
			const who = tx.select().from(profiles).where(eq(profiles.id, request.profileId)).get();
			let jobId: string | null = null;
			if (decision === 'approve') {
				const spool = request.spoolId
					? tx.select().from(spools).where(eq(spools.id, request.spoolId)).get()
					: undefined;
				const count =
					tx
						.select({ n: sql<number>`count(*)` })
						.from(jobs)
						.where(eq(jobs.projectId, project.id))
						.get()?.n ?? 0;
				jobId = uuid();
				tx.insert(jobs)
					.values({
						id: jobId,
						projectId: project.id,
						status: 'Queued',
						revision: `v${String(count + 1).padStart(2, '0')}`,
						spoolId: spool?.id ?? null,
						material: spool?.material ?? '',
						modelVersionId: request.modelVersionId,
						notes: `Asked for by ${who?.name ?? 'a kid'}${request.message ? `: “${request.message}”` : ''}`
					})
					.run();
				if (project.status === 'Idea')
					tx.update(projects)
						.set({ status: 'Planned', updatedAt: nowIso(), version: sql`${projects.version} + 1` })
						.where(eq(projects.id, project.id))
						.run();
			}
			this.versioned(
				tx,
				printRequests,
				id,
				version,
				{
					status: decision === 'approve' ? 'Approved' : 'Declined',
					reply,
					jobId,
					decidedAt: nowIso()
				},
				'print request'
			);
			this.log(
				tx,
				'request',
				decision === 'approve'
					? `Said yes to printing ${who?.name ?? 'a kid'}’s “${project.title}”`
					: `Said not this time to ${who?.name ?? 'a kid'}’s “${project.title}”`,
				project.id,
				jobId
			);
			return jobId;
		});
	}
}
