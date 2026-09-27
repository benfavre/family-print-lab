// Undo and redo for the workspace: whole-project snapshots (projects are small next to their meshes,
// which are stored apart), with a label for the button's tooltip.

export interface Step<T> {
	label: string;
	state: T;
}

export class History<T> {
	private past: Step<T>[] = [];
	private future: Step<T>[] = [];

	constructor(private limit = 100) {}

	/** Records the state before a change. */
	push(label: string, before: T) {
		this.past.push({ label, state: before });
		if (this.past.length > this.limit) this.past.shift();
		this.future = [];
	}

	/** The state to go back to, given the current one (kept for redo); null when there is none. */
	undo(current: T): Step<T> | null {
		const step = this.past.pop();
		if (!step) return null;
		this.future.push({ label: step.label, state: current });
		return step;
	}

	redo(current: T): Step<T> | null {
		const step = this.future.pop();
		if (!step) return null;
		this.past.push({ label: step.label, state: current });
		return step;
	}

	get undoLabel(): string | null {
		return this.past.at(-1)?.label ?? null;
	}
	get redoLabel(): string | null {
		return this.future.at(-1)?.label ?? null;
	}

	clear() {
		this.past = [];
		this.future = [];
	}
}
