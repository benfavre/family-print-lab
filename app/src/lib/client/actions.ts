// User actions, shared by buttons, the context menu, the command palette and keyboard shortcuts.
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import {
	FINISHED_JOB,
	PROJECT_STATUSES,
	type Job,
	type JobStatus,
	type Project,
	type ProjectStatus
} from '$lib/shared/domain';
import type { AppContext, MenuItem } from './app.svelte';
import { fileUrl, meshFormat, modelHref } from './models';
import type { ModelSummary } from '$lib/shared/domain';
import { duration, weight } from './format';

export const projectHref = (id: string) => resolve('/projects/[id]', { id });

export function actions({ lab, ui }: AppContext) {
	const a = {
		togglePin: (p: Project) =>
			lab.call(
				'PUT',
				`/api/projects/${p.id}/pin`,
				{ pinned: !p.pinned },
				p.pinned ? 'Unpinned.' : 'Pinned to the top.'
			),
		setStatus: (p: Project, status: ProjectStatus) =>
			lab.call('PUT', `/api/projects/${p.id}/status`, { status }, `Moved to ${status}.`),
		async duplicate(p: Project) {
			const res = await lab.call<{ id: string }>(
				'POST',
				`/api/projects/${p.id}/duplicate`,
				undefined,
				'Duplicated. Jobs were not copied.'
			);
			if (res) await goto(resolve('/projects/[id]', { id: res.id }));
		},
		async deleteProject(p: Project) {
			const count = lab.jobsFor(p.id).length;
			if (
				!(await ui.ask(
					`Delete “${p.title}”?`,
					`This removes the project${count ? ` and its ${count} print ${count === 1 ? 'job' : 'jobs'}` : ''}. Filament they used goes back to the spools. Design and slicer files are not deleted.`
				))
			)
				return false;
			const ok = await lab.call('DELETE', `/api/projects/${p.id}`, undefined, 'Project deleted.');
			return !!ok;
		},
		async copyLink(p: Project) {
			const url = new URL(projectHref(p.id), location.origin).href;
			try {
				await navigator.clipboard.writeText(url);
				ui.toast('Link copied.');
			} catch {
				ui.toast(url);
			}
		},
		async transition(job: Job, to: JobStatus) {
			const task = lab.printerActive ? lab.printer.state?.task : '';
			const link =
				to === 'Printing' &&
				task &&
				!lab.ws.jobs.some((j) => j.status === 'Printing' && j.printerTask === task)
					? { printerTask: task }
					: {};
			const alsoPrinting =
				to === 'Printing' && lab.ws.jobs.some((j) => j.status === 'Printing' && j.id !== job.id);
			const res = await lab.call<{ autoDone?: boolean }>('POST', `/api/jobs/${job.id}/transition`, {
				to,
				...link
			});
			if (!res) return;
			ui.toast(
				{
					Queued: 'Back in the queue.',
					Printing: link.printerTask
						? `Started and linked to the printer’s “${link.printerTask}”.`
						: alsoPrinting
							? 'Started. Note: another job is also printing.'
							: 'Print started.',
					Succeeded: res.autoDone
						? 'Print succeeded — project marked Done.'
						: 'Print logged as succeeded.',
					Failed: 'Logged as failed. Try ✦ Diagnose for likely causes.',
					Cancelled: 'Job cancelled.'
				}[to]
			);
		},
		reprint: (job: Job, overrides: Record<string, unknown> = {}) =>
			lab.call('POST', `/api/jobs/${job.id}/reprint`, overrides, 'Queued again.'),
		linkRunning: (job: Job) => {
			const task = lab.printer.state?.task;
			if (!task) return;
			return job.status === 'Printing'
				? lab.call(
						'PATCH',
						`/api/jobs/${job.id}`,
						{ version: job.version, printerTask: task },
						`Linked to “${task}”.`
					)
				: lab.call(
						'POST',
						`/api/jobs/${job.id}/transition`,
						{ to: 'Printing', printerTask: task },
						`Linked to “${task}”. It will close itself when the printer finishes.`
					);
		},
		unlink: (job: Job) =>
			lab.call(
				'PATCH',
				`/api/jobs/${job.id}`,
				{ version: job.version, printerTask: '' },
				'Unlinked from the printer.'
			),
		toggleStep: (p: Project, stepId: string, done: boolean) =>
			lab.call('PATCH', `/api/projects/${p.id}/checklist/${stepId}`, { done }),
		addStep: (p: Project, text: string) =>
			lab.call('POST', `/api/projects/${p.id}/checklist`, { text }),
		removeStep: (p: Project, stepId: string) =>
			lab.call('DELETE', `/api/projects/${p.id}/checklist/${stepId}`),
		setChecklist: (p: Project, steps: string[], mode: 'replace' | 'append') =>
			lab.call(
				'PUT',
				`/api/projects/${p.id}/checklist`,
				{ steps, mode },
				mode === 'replace' ? 'Checklist replaced.' : 'Steps added.'
			),
		async newModel(
			projectId: string,
			name = 'New part',
			source?: string,
			origin: 'editor' | 'ai' = 'editor',
			taskId?: string
		) {
			const res = await lab.call<{ id: string }>(
				'POST',
				'/api/models',
				{ projectId, name, source, origin, taskId },
				origin === 'ai' ? 'Model created from the AI design.' : undefined
			);
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- modelHref() is built with resolve()
			if (res) await goto(modelHref(projectId, res.id));
			return res?.id ?? null;
		},
		/** Attaches a sliced .gcode.3mf (exported from Bambu Studio) to a queued job. */
		async attachSliced(job: Job, file: File) {
			if (!/\.3mf$/i.test(file.name))
				return (ui.toast('Choose the sliced file (.gcode.3mf) from Bambu Studio.', 'error'), false);
			if (file.size > 110_000_000)
				return (ui.toast('Sliced files must be under 110 MB.', 'error'), false);
			lab.saving++;
			try {
				const r = await fetch(
					`/api/jobs/${job.id}/sliced?${new URLSearchParams({ name: file.name })}`,
					{ method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file }
				);
				const data = await r.json().catch(() => ({}));
				if (!r.ok) throw new Error(data.error ?? `Upload failed (${r.status}).`);
				if (data.workspace) lab.ws = data.workspace;
				const plate = data.sliced.plates.find(
					(p: { index: number }) => p.index === data.sliced.plate
				);
				ui.toast(
					`Sliced file attached: ${data.sliced.plates.length > 1 ? `${data.sliced.plates.length} plates, ` : ''}${duration(plate.minutes)}, ${weight(plate.grams)}.`
				);
				return true;
			} catch (error) {
				ui.toast((error as Error).message, 'error');
				return false;
			} finally {
				lab.saving--;
			}
		},
		async detachSliced(job: Job) {
			return !!(await lab.call(
				'DELETE',
				`/api/jobs/${job.id}/sliced`,
				undefined,
				'Sliced file removed.'
			));
		},
		/** Whether Bambu Studio is installed for slicing here. */
		canSlice() {
			return !!lab.integrations?.items.find((i) => i.id === 'slicer')?.available;
		},
		/** Slices a queued job's model version in Bambu Studio (background task); the file attaches itself. */
		async sliceJob(job: Job) {
			const res = await lab.call<{ task: { id: string } }>(
				'POST',
				`/api/jobs/${job.id}/slice`,
				{},
				'Slicing in Bambu Studio…'
			);
			if (res) ui.watching.add(res.task.id);
			return !!res;
		},
		/** Opens the send window for a queued job with a sliced file. */
		sendToPrinter(job: Job) {
			ui.openSend(job.id);
		},
		async printerControl(action: 'pause' | 'resume' | 'stop') {
			if (
				action === 'stop' &&
				!(await ui.ask(
					'Stop this print?',
					'The printer stops and the plate cannot be resumed. The job is marked as failed when the printer reports it.',
					'Stop print'
				))
			)
				return false;
			const done = { pause: 'Pausing…', resume: 'Resuming…', stop: 'Stopping…' }[action];
			return !!(await lab.call('POST', '/api/printer/control', { action }, done));
		},
		/** Uploads an STL/3MF/OBJ file as a new mesh model. */
		async uploadModel(projectId: string, file: File, open = true) {
			const format = meshFormat(file.name);
			if (!format) return (ui.toast('Choose an STL, 3MF or OBJ file.', 'error'), null);
			if (file.size > 100_000_000)
				return (ui.toast('Model files must be under 100 MB.', 'error'), null);
			const name = file.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'Imported part';
			lab.saving++;
			try {
				const params = new URLSearchParams({ projectId, name, format });
				const r = await fetch(`/api/models/upload?${params}`, {
					method: 'POST',
					headers: { 'content-type': 'application/octet-stream' },
					body: file
				});
				const data = await r.json().catch(() => ({}));
				if (!r.ok) throw new Error(data.error ?? `Upload failed (${r.status}).`);
				if (data.workspace) lab.ws = data.workspace;
				ui.toast(`Imported “${name}”.`);
				// eslint-disable-next-line svelte/no-navigation-without-resolve -- modelHref() is built with resolve()
				if (open) await goto(modelHref(projectId, data.id));
				return data.id as string;
			} catch (error) {
				ui.toast((error as Error).message, 'error');
				return null;
			} finally {
				lab.saving--;
			}
		},
		async deleteModel(m: ModelSummary) {
			const linked = lab.ws.jobs.filter((j) =>
				m.versions.some((v) => v.id === j.modelVersionId)
			).length;
			if (
				!(await ui.ask(
					`Delete “${m.name}”?`,
					`This removes the model and all ${m.versions.length} ${m.versions.length === 1 ? 'version' : 'versions'}.${linked ? ` ${linked} print ${linked === 1 ? 'job keeps' : 'jobs keep'} their records but lose the link to the file.` : ''} Backups still contain it.`
				))
			)
				return false;
			return !!(await lab.call('DELETE', `/api/models/${m.id}`, undefined, 'Model deleted.'));
		},
		exportBackup() {
			const link = document.createElement('a');
			link.href = '/api/export';
			link.click();
			ui.toast('Backup downloaded.');
		},
		async importBackup(file: File) {
			let data: unknown;
			try {
				data = JSON.parse(await file.text());
			} catch {
				ui.toast('That file is not a valid JSON backup.', 'error');
				return;
			}
			if (
				!(await ui.ask(
					'Restore this backup?',
					`This replaces all profiles, projects, jobs and spools with “${file.name}”. A safety copy of the current database is saved first.`,
					'Restore'
				))
			)
				return;
			if (await lab.call('POST', '/api/import', data, 'Backup restored.')) await goto(resolve('/'));
		},
		async snapshotNow() {
			const res = await lab.call<{ backup: { file: string } }>('POST', '/api/backups');
			if (res) ui.toast(`Database backup saved: ${res.backup.file}`);
		}
	};
	return a;
}

export function projectMenu(app: AppContext, p: Project): MenuItem[] {
	const a = actions(app);
	return [
		{ label: 'Open', href: projectHref(p.id) },
		{ label: p.pinned ? 'Unpin' : 'Pin to top', run: () => a.togglePin(p) },
		{ label: '', separator: true },
		{ label: 'Progress', heading: true },
		...PROJECT_STATUSES.map((s) => ({
			label: s,
			dot: s,
			checked: s === p.status,
			run: () => a.setStatus(p, s)
		})),
		{ label: '', separator: true },
		{ label: 'Queue a print…', run: () => app.ui.openEditor('job', null, { projectId: p.id }) },
		{ label: 'Edit details…', run: () => app.ui.openEditor('project', p.id) },
		{ label: 'Duplicate', run: () => a.duplicate(p) },
		{ label: 'Copy link', run: () => a.copyLink(p) },
		{ label: '', separator: true },
		{ label: 'Delete…', danger: true, run: () => a.deleteProject(p) }
	];
}

export function jobMenu(app: AppContext, job: Job): MenuItem[] {
	const a = actions(app);
	return [
		...(job.status === 'Queued'
			? [{ label: 'Start print', run: () => a.transition(job, 'Printing') }]
			: []),
		...(job.status === 'Printing'
			? [
					{ label: 'Mark succeeded', run: () => a.transition(job, 'Succeeded') },
					{ label: 'Mark failed', run: () => a.transition(job, 'Failed') }
				]
			: []),
		...(FINISHED_JOB.has(job.status) ? [{ label: 'Print again', run: () => a.reprint(job) }] : []),
		...(job.status === 'Queued' || job.status === 'Printing'
			? [{ label: 'Cancel', run: () => a.transition(job, 'Cancelled') }]
			: []),
		{ label: 'Edit job…', run: () => app.ui.openEditor('job', job.id) },
		{ label: 'Open project', href: projectHref(job.projectId) }
	];
}

export function openMenu(
	app: AppContext,
	title: string,
	items: MenuItem[],
	x: number,
	y: number,
	returnTo: HTMLElement | null,
	above = false
) {
	app.ui.menu = { title, items, x, y, returnTo, above };
}

export function modelMenu(app: AppContext, m: ModelSummary): MenuItem[] {
	const a = actions(app);
	const current = m.versions.find((v) => v.id === m.currentVersionId);
	return [
		{ label: 'Open in workbench', href: modelHref(m.projectId, m.id) },
		...(current
			? [
					{
						label: 'Queue a print…',
						run: () =>
							app.ui.openEditor('job', null, { projectId: m.projectId, modelVersionId: current.id })
					},
					{
						label: 'Download STL',
						run: () => download(`${fileUrl(m.id, current.id, 'model.stl')}?download`)
					},
					{
						label: 'Download 3MF',
						run: () => download(`${fileUrl(m.id, current.id, 'model.3mf')}?download`)
					}
				]
			: []),
		{ label: '', separator: true },
		{ label: 'Delete…', danger: true, run: () => a.deleteModel(m) }
	];
}

export function download(url: string) {
	const link = document.createElement('a');
	link.href = url;
	link.download = '';
	link.click();
}
