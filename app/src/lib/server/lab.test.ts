import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, type DB } from './db';
import { Lab } from './lab';
import { exportWorkspace, parseImport, replaceWorkspace } from './portability';
import { AppError } from './validation';

const legacy = JSON.parse(
	fs.readFileSync(path.join(import.meta.dirname, '__fixtures__/legacy-v1.json'), 'utf8')
);

let db: DB, lab: Lab;
beforeEach(() => {
	db = openDatabase(':memory:');
	lab = new Lab(db);
});

const person = () => lab.createProfile({ name: 'Alex', color: 'blue', age: 9 });
const expectError = (fn: () => unknown, status: number, match?: RegExp) => {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(AppError);
		expect((error as AppError).status).toBe(status);
		if (match) expect((error as AppError).message).toMatch(match);
		return;
	}
	throw new Error('expected an AppError');
};

describe('bulk project changes', () => {
	it('changes status, owner, category and pins for many projects in one change', () => {
		const alex = person();
		const sam = lab.createProfile({ name: 'Sam', color: 'green' });
		const ids = ['A', 'B', 'C'].map((t) => lab.createProject({ profileId: alex, title: t }));
		const before = lab.changeId();
		expect(lab.bulkProjects({ ids, action: 'status', value: 'Planned' })).toEqual({
			count: 3,
			created: []
		});
		expect(lab.changeId()).toBe(before + 1); // one change for the whole batch
		lab.bulkProjects({ ids: ids.slice(0, 2), action: 'owner', value: sam });
		lab.bulkProjects({ ids, action: 'category', value: 'Creative' });
		lab.bulkProjects({ ids: [ids[2]], action: 'pin' });
		const byId = new Map(lab.snapshot().projects.map((p) => [p.id, p]));
		expect(ids.map((id) => byId.get(id)!.status)).toEqual(['Planned', 'Planned', 'Planned']);
		expect(ids.map((id) => byId.get(id)!.profileId)).toEqual([sam, sam, alex]);
		expect(ids.map((id) => byId.get(id)!.category)).toEqual(['Creative', 'Creative', 'Creative']);
		expect(ids.map((id) => byId.get(id)!.pinned)).toEqual([false, false, true]);
		expect(lab.snapshot().activity.filter((a) => a.message === 'Moved to Planned')).toHaveLength(3);
	});

	it('duplicates and deletes in bulk, refunding filament of deleted jobs', () => {
		const profileId = person();
		const ids = ['A', 'B'].map((t) => lab.createProject({ profileId, title: t }));
		const { created } = lab.bulkProjects({ ids, action: 'duplicate' });
		expect(created).toHaveLength(2);
		expect(
			lab
				.snapshot()
				.projects.map((p) => p.title)
				.sort()
		).toEqual(['A', 'A (copy)', 'B', 'B (copy)']);
		const spoolId = lab.createSpool({
			material: 'PLA',
			colorName: 'Red',
			colorHex: '#ff0000',
			totalGrams: 1000,
			remainingGrams: 1000
		});
		const job = lab.createJob({ projectId: ids[0], spoolId, grams: 50 });
		lab.transitionJob(job, { to: 'Printing' });
		lab.transitionJob(job, { to: 'Succeeded' });
		expect(lab.snapshot().spools[0].remainingGrams).toBe(950);
		lab.bulkProjects({ ids, action: 'delete' });
		expect(
			lab
				.snapshot()
				.projects.map((p) => p.title)
				.sort()
		).toEqual(['A (copy)', 'B (copy)']);
		expect(lab.snapshot().spools[0].remainingGrams).toBe(1000);
	});

	it('is all or nothing: one missing project or a bad value changes nothing', () => {
		const profileId = person();
		const ids = ['A', 'B'].map((t) => lab.createProject({ profileId, title: t }));
		expectError(
			() => lab.bulkProjects({ ids: [...ids, 'gone'], action: 'status', value: 'Done' }),
			404
		);
		expectError(() => lab.bulkProjects({ ids, action: 'status', value: 'Nope' }), 400);
		expectError(() => lab.bulkProjects({ ids, action: 'owner', value: 'nobody' }), 404);
		expectError(() => lab.bulkProjects({ ids: [], action: 'pin' }), 400);
		expect(lab.snapshot().projects.every((p) => p.status === 'Idea')).toBe(true);
	});
});

describe('projects', () => {
	it('creates with a starter checklist, logs activity and bumps the change id', () => {
		const profileId = person();
		const before = lab.changeId();
		const id = lab.createProject({ profileId, title: 'Desk cable dock', category: 'Office' });
		const ws = lab.snapshot();
		const project = ws.projects.find((p) => p.id === id)!;
		expect(project.checklist).toHaveLength(6);
		expect(project.status).toBe('Idea');
		expect(ws.changeId).toBe(before + 1);
		expect(ws.activity[0].message).toContain('Desk cable dock');
	});

	it('rejects invalid input with readable messages', () => {
		const profileId = person();
		expectError(() => lab.createProject({ profileId, title: '' }), 400, /title/);
		expectError(
			() => lab.createProject({ profileId, title: 'x', url: 'javascript:alert(1)' }),
			400,
			/https/
		);
		expectError(() => lab.createProject({ profileId, title: 'x', status: 'Maybe' }), 400);
		expectError(() => lab.createProject({ profileId, title: 'x', extra: 1 }), 400);
		expectError(() => lab.createProject({ profileId: 'nobody', title: 'x' }), 404);
	});

	it('uses per-row versions so stale edits conflict but unrelated edits do not', () => {
		const profileId = person();
		const a = lab.createProject({ profileId, title: 'A' });
		const b = lab.createProject({ profileId, title: 'B' });
		lab.updateProject(a, { version: 1, notes: 'first tab' });
		expectError(() => lab.updateProject(a, { version: 1, notes: 'stale tab' }), 409);
		lab.updateProject(b, { version: 1, notes: 'other project is fine' });
		expect(lab.snapshot().projects.find((p) => p.id === a)!.notes).toBe('first tab');
		expectError(() => lab.updateProject('missing', { version: 1, title: 'x' }), 404);
	});

	it('keeps a profile with projects from being deleted', () => {
		const profileId = person();
		lab.createProject({ profileId, title: 'A' });
		expectError(() => lab.deleteProfile(profileId), 409, /Reassign/);
	});

	it('duplicates without jobs and with an unchecked checklist', () => {
		const profileId = person();
		const id = lab.createProject({
			profileId,
			title: 'A',
			checklist: [{ text: 'Measure', done: true }]
		});
		const copy = lab.duplicateProject(id);
		const p = lab.snapshot().projects.find((x) => x.id === copy)!;
		expect(p.title).toBe('A (copy)');
		expect(p.checklist).toEqual([expect.objectContaining({ text: 'Measure', done: false })]);
	});

	it('replaces a checklist while keeping the done state of unchanged steps', () => {
		const profileId = person();
		const id = lab.createProject({
			profileId,
			title: 'A',
			checklist: [
				{ text: 'Measure', done: true },
				{ text: 'Old', done: false }
			]
		});
		lab.setChecklist(id, { steps: ['measure', 'Print'], mode: 'replace' });
		expect(lab.snapshot().projects[0].checklist.map((c) => [c.text, c.done])).toEqual([
			['measure', true],
			['Print', false]
		]);
	});
});

describe('jobs and filament', () => {
	const setup = () => {
		const profileId = person();
		const projectId = lab.createProject({ profileId, title: 'Dock', status: 'Planned' });
		const spoolId = lab.createSpool({
			material: 'PLA',
			colorHex: '#ff7a2f',
			totalGrams: 1000,
			remainingGrams: 500
		});
		return { projectId, spoolId };
	};
	const spool = (id: string) => lab.snapshot().spools.find((s) => s.id === id)!;
	const project = (id: string) => lab.snapshot().projects.find((p) => p.id === id)!;
	const job = (id: string) => lab.snapshot().jobs.find((j) => j.id === id)!;

	it('runs the lifecycle: start moves the project, success charges the spool and finishes the project', () => {
		const { projectId, spoolId } = setup();
		const id = lab.createJob({ projectId, spoolId, grams: 60 });
		expect(job(id).revision).toBe('v01');
		lab.transitionJob(id, { to: 'Printing' });
		expect(project(projectId).status).toBe('Printing');
		const { autoDone } = lab.transitionJob(id, { to: 'Succeeded' });
		expect(autoDone).toBe(true);
		expect(project(projectId).status).toBe('Done');
		expect(spool(spoolId).remainingGrams).toBe(440);
		expect(job(id)).toMatchObject({ chargeSpoolId: spoolId, chargeGrams: 60 });
		expect(job(id).actualMinutes).toBeGreaterThanOrEqual(1);
	});

	it('refunds exactly when a finished job is edited, moved to another spool, or deleted', () => {
		const { projectId, spoolId } = setup();
		const other = lab.createSpool({
			material: 'PETG',
			colorHex: '#1fb8a6',
			totalGrams: 1000,
			remainingGrams: 900
		});
		const id = lab.createJob({ projectId, spoolId, grams: 60, status: 'Succeeded' });
		expect(spool(spoolId).remainingGrams).toBe(440);
		lab.updateJob(id, { version: job(id).version, grams: 100 });
		expect(spool(spoolId).remainingGrams).toBe(400);
		lab.updateJob(id, { version: job(id).version, spoolId: other });
		expect(spool(spoolId).remainingGrams).toBe(500);
		expect(spool(other).remainingGrams).toBe(800);
		lab.deleteJob(id);
		expect(spool(other).remainingGrams).toBe(900);
	});

	it('never takes a spool below zero and never refunds above its size', () => {
		const { projectId, spoolId } = setup();
		const id = lab.createJob({ projectId, spoolId, grams: 700, status: 'Failed' });
		expect(spool(spoolId).remainingGrams).toBe(0);
		expect(job(id).chargeGrams).toBe(500);
		lab.deleteJob(id);
		expect(spool(spoolId).remainingGrams).toBe(500);
	});

	it('treats a hand-entered spool weight as a new baseline', () => {
		const { projectId, spoolId } = setup();
		const id = lab.createJob({ projectId, spoolId, grams: 60, status: 'Succeeded' });
		lab.updateSpool(spoolId, { version: spool(spoolId).version, remainingGrams: 300 });
		lab.deleteJob(id);
		expect(spool(spoolId).remainingGrams).toBe(300);
	});

	it('refunds every job when a project is deleted', () => {
		const { projectId, spoolId } = setup();
		lab.createJob({ projectId, spoolId, grams: 50, status: 'Succeeded' });
		lab.createJob({ projectId, spoolId, grams: 25, status: 'Failed' });
		expect(spool(spoolId).remainingGrams).toBe(425);
		lab.deleteProject(projectId);
		expect(spool(spoolId).remainingGrams).toBe(500);
		expect(lab.snapshot().jobs).toHaveLength(0);
	});

	it('reprints with the same settings as a new queued job', () => {
		const { projectId, spoolId } = setup();
		const id = lab.createJob({
			projectId,
			spoolId,
			grams: 60,
			layerHeight: '0.16',
			status: 'Failed'
		});
		const again = lab.reprintJob(id, { notes: 'after cleaning' });
		expect(job(again)).toMatchObject({
			status: 'Queued',
			revision: 'v02',
			layerHeight: '0.16',
			chargeGrams: 0,
			notes: 'after cleaning'
		});
	});

	it('links a printer task to the single unlinked running job and closes it on the outcome', () => {
		const { projectId, spoolId } = setup();
		const id = lab.createJob({ projectId, spoolId, grams: 40 });
		lab.transitionJob(id, { to: 'Printing' });
		expect(lab.linkStartedTask('dock_v01')).toBe(id);
		expect(lab.linkStartedTask('dock_v01')).toBeNull();
		expect(lab.closePrinterTask('other_task', true)).toBeNull();
		expect(lab.closePrinterTask('dock_v01', false)).toBe(id);
		expect(job(id)).toMatchObject({ status: 'Failed', chargeGrams: 40 });
		expect(job(id).notes).toMatch(/failed/);
	});

	it('announces every committed change to live listeners', () => {
		const seen: string[] = [];
		lab.events.on('change', (e) => seen.push(e.kind));
		const { projectId } = setup();
		lab.createJob({ projectId });
		expectError(() => lab.createJob({ projectId: 'missing' }), 404);
		expect(seen).toEqual(['profile', 'project', 'spool', 'job']);
	});
});

describe('import and export', () => {
	it('imports a legacy family.json, including jobs, spools and filament charges', () => {
		replaceWorkspace(db, lab, parseImport(legacy));
		const ws = lab.snapshot();
		expect(ws.profiles).toHaveLength(legacy.profiles.length);
		expect(ws.projects).toHaveLength(legacy.projects.length);
		expect(ws.jobs).toHaveLength(legacy.jobs.length);
		const charged = legacy.jobs.find((j: { charge: unknown }) => j.charge);
		expect(ws.jobs.find((j) => j.id === charged.id)).toMatchObject({
			chargeSpoolId: charged.charge.spoolId,
			chargeGrams: charged.charge.grams
		});
		expect(ws.projects.every((p) => p.pinned === false)).toBe(true);
	});

	it('round-trips its own export', () => {
		replaceWorkspace(db, lab, parseImport(legacy));
		lab.setPinned(lab.snapshot().projects[0].id, true);
		const exported = JSON.parse(JSON.stringify(exportWorkspace(lab)));
		const other = openDatabase(':memory:');
		const otherLab = new Lab(other);
		replaceWorkspace(other, otherLab, parseImport(exported));
		const strip = (ws: ReturnType<Lab['snapshot']>) => ({
			projects: ws.projects.map(({ version: _v, updatedAt: _u, checklist, ...p }) => ({
				...p,
				checklist: checklist.map((c) => [c.text, c.done])
			})),
			jobs: ws.jobs.map(({ version: _v, updatedAt: _u, ...j }) => j),
			spools: ws.spools.map(({ version: _v, updatedAt: _u, ...s }) => s)
		});
		expect(strip(otherLab.snapshot())).toEqual(strip(lab.snapshot()));
	});

	it('rejects broken backups without touching the current data', () => {
		const profileId = person();
		lab.createProject({ profileId, title: 'Keep me' });
		expectError(
			() => parseImport({ profiles: [], projects: [{ id: 'p', profileId: 'ghost', title: 'x' }] }),
			400,
			/missing family member/
		);
		expectError(() => parseImport({ nothing: true }), 400);
		expect(lab.snapshot().projects.map((p) => p.title)).toEqual(['Keep me']);
	});
});
