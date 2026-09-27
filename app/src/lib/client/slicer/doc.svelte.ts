// The project being edited in the workspace: the Project as last changed here, its undo history and
// saving (debounced, with the revision as If-Match so a save never overwrites someone else's).
import type { Project } from '$lib/shared/slicer/project';
import type { SlicerProjectSummary } from '$lib/shared/slicer-3mf';
import { History } from './history';

const SAVE_DELAY_MS = 1200;

export class SlicerDoc {
	project = $state.raw<Project>() as Project;
	/** The revision on the server that `project` was saved as (null: never loaded). */
	revision = $state<number | null>(null);
	/** Unsaved edits. */
	dirty = $state(false);
	saving = $state(false);
	/** Why the last save failed, in plain words. */
	problem = $state('');
	undoLabel = $state<string | null>(null);
	redoLabel = $state<string | null>(null);
	private history = new History<Project>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private pending: Promise<boolean> | null = null;

	constructor(
		readonly id: string,
		project: Project,
		revision: number,
		private onSaved: (s: SlicerProjectSummary) => void = () => {}
	) {
		this.project = project;
		this.revision = revision;
	}

	/**
	 * Makes a change as one undo step (`merge`: part of the last step, like the rest of a painting
	 * stroke). `fn` edits a copy; if it throws, the project stays as it was.
	 */
	edit(label: string, fn: (draft: Project) => void, merge = false) {
		const before = this.project;
		const draft = structuredClone(before);
		fn(draft);
		if (!merge) this.history.push(label, before);
		this.project = draft;
		this.changed();
	}

	undo() {
		const step = this.history.undo(this.project);
		if (step) {
			this.project = step.state;
			this.changed();
		}
	}

	redo() {
		const step = this.history.redo(this.project);
		if (step) {
			this.project = step.state;
			this.changed();
		}
	}

	private changed() {
		this.undoLabel = this.history.undoLabel;
		this.redoLabel = this.history.redoLabel;
		this.dirty = true;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.save(), SAVE_DELAY_MS);
	}

	/** Saves now if there is anything to save; resolves true when the server has the project. */
	async save(): Promise<boolean> {
		clearTimeout(this.timer);
		if (this.pending) await this.pending;
		if (!this.dirty) return !this.problem;
		const project = this.project;
		this.pending = (async () => {
			this.saving = true;
			try {
				const r = await fetch(`/api/slicer-projects/${this.id}`, {
					method: 'PUT',
					headers: { 'content-type': 'application/json', 'if-match': String(this.revision ?? '') },
					body: JSON.stringify(project)
				});
				const data = await r.json().catch(() => ({}));
				if (!r.ok) {
					this.problem = data.error ?? `Saving failed (${r.status}).`;
					return false;
				}
				const summary = data.slicerProject as SlicerProjectSummary;
				this.revision = summary.revision;
				this.problem = '';
				// Edits made while saving are still unsaved.
				if (this.project === project) this.dirty = false;
				else this.changed();
				this.onSaved(summary);
				return true;
			} catch {
				this.problem = 'Could not reach the app server to save.';
				return false;
			} finally {
				this.saving = false;
				this.pending = null;
			}
		})();
		return this.pending;
	}

	/** Takes a project from the server (after a conflict or someone else's save), dropping local edits. */
	replace(project: Project, revision: number) {
		clearTimeout(this.timer);
		this.history.clear();
		this.project = project;
		this.revision = revision;
		this.dirty = false;
		this.problem = '';
		this.undoLabel = this.redoLabel = null;
	}

	dispose() {
		clearTimeout(this.timer);
	}
}
