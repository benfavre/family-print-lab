// Client state: the live workspace (kept in sync over server-sent events) and UI state (filters,
// dialogs, toasts, menus). Created once per page load in the root layout and shared via context.
import { getContext, setContext, untrack } from 'svelte';
import {
	ACTIVE_PRINTER_STATES,
	type Category,
	type Job,
	type ModelSummary,
	type ModelVersionSummary,
	type PrinterStatus,
	type Profile,
	type Project,
	type ProjectStatus,
	type Spool,
	type Workspace
} from '$lib/shared/domain';
import type { IntegrationsReport } from '$lib/shared/integrations';
import type { TaskInfo } from '$lib/shared/tasks';

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
	}
}

export type EditorKind = 'project' | 'profile' | 'job' | 'spool';
/** A floating window (like a Gmail draft): an editor or the AI design window, docked bottom-right. */
export interface Panel {
	key: string;
	kind: EditorKind | 'design' | 'sketch' | 'send';
	id: string | null;
	preset: Record<string, unknown>;
	/** Shown in the title bar; the content sets it. */
	title: string;
	minimized: boolean;
	expanded: boolean;
}
export interface Toast {
	id: number;
	message: string;
	tone: 'ok' | 'error';
}
export interface MenuItem {
	label: string;
	run?: () => unknown;
	href?: string;
	checked?: boolean;
	danger?: boolean;
	dot?: ProjectStatus;
	separator?: boolean;
	heading?: boolean;
}

/** A model for the page visualizer, with print progress when it is on the printer. */
export interface StageModel {
	modelId: string;
	versionId: string;
	name: string;
	projectId: string;
	/** 0..1 while printing (live or estimated), else null for the looping preview. */
	progress: number | null;
	live: boolean;
}

export const THEMES = [
	['auto', 'Auto', 'Follows your system'],
	['holo', 'Holo', 'Cyan and violet on deep navy'],
	['nebula', 'Nebula', 'Pink and lavender on plum'],
	['ember', 'Ember', 'Warm amber on charcoal'],
	['terminal', 'Terminal', 'Phosphor green on black'],
	['arctic', 'Arctic', 'Light, crisp blue'],
	['sand', 'Sand', 'Light, warm paper']
] as const;

export class UiState {
	profile = $state('all');
	profileLocked = $state(true);
	hasEntered = $state(false);

	selectProfile(id: string) {
		this.profile = id;
		this.status = 'All';
		this.query = '';
		this.selected = [];
		this.profileLocked = false;
		this.hasEntered = true;
	}

	lockProfile() {
		this.profileLocked = true;
		this.paletteOpen = false;
		this.shortcutsOpen = false;
		this.menu = null;
		this.assistantOpen = false;
		try {
			sessionStorage.removeItem('print-lab-profile');
		} catch {
			/* Storage may be unavailable; the picker still works for this page. */
		}
	}
	status = $state<'All' | ProjectStatus>('All');
	query = $state('');
	/** Open floating panels, oldest first (the newest sits at the right). */
	panels = $state<Panel[]>([]);
	confirm = $state<{
		title: string;
		text: string;
		ok: string;
		resolve: (ok: boolean) => void;
	} | null>(null);
	toasts = $state<Toast[]>([]);
	paletteOpen = $state(false);
	shortcutsOpen = $state(false);
	/** How the project grid and sidebar are ordered (pinned projects always come first). */
	sort = $state<'updated' | 'created' | 'name' | 'progress' | 'person'>('updated');
	/** Projects selected on the home grid for bulk changes. */
	selected = $state<string[]>([]);
	/** Task ids a dialog is showing, so their completion does not also raise a toast. */
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- bookkeeping, never rendered
	watching = new Set<string>();
	assistantOpen = $state(false);
	menu = $state<{
		title: string;
		items: MenuItem[];
		x: number;
		y: number;
		returnTo: HTMLElement | null;
		/** Open upward, ending at y (for menus from a bar at the bottom of the screen). */
		above?: boolean;
	} | null>(null);
	theme = $state('auto');
	/** Category previewed by the 3D stage when hovering a card. */
	previewCategory = $state<Category | null>(null);
	/** Project hovered on the home grid, so the stage can show its real model. */
	previewProjectId = $state<string | null>(null);
	/** Ticks every few seconds so estimated print progress stays current. */
	now = $state(Date.now());
	/** Set by the assistant drawer: opens it and runs a structured task (ideas, diagnose, settings, checklist). */
	assistantTask: ((task: string, input: Record<string, unknown>) => void) | null = null;
	/** Set by the assistant drawer: opens it with a prefilled question. */
	assistantAsk: ((question: string) => void) | null = null;
	private nextToast = 1;

	toast(message: string, tone: Toast['tone'] = 'ok') {
		const id = this.nextToast++;
		this.toasts = [...this.toasts.slice(-2), { id, message, tone }];
		setTimeout(
			() => (this.toasts = this.toasts.filter((t) => t.id !== id)),
			tone === 'error' ? 6000 : 3500
		);
	}

	ask(title: string, text: string, ok = 'Delete'): Promise<boolean> {
		return new Promise((resolve) => (this.confirm = { title, text, ok, resolve }));
	}

	/** Opens an editor in a floating panel; the same record's panel is brought back instead of duplicated. */
	openEditor(kind: EditorKind, id: string | null = null, preset: Record<string, unknown> = {}) {
		const existing = id ? this.panels.find((p) => p.kind === kind && p.id === id) : undefined;
		if (existing) return this.focusPanel(existing.key);
		this.addPanel({ kind, id, preset });
	}

	/** The AI design window for a project, optionally showing tasks that are running or done. */
	openDesign(projectId: string, taskIds: string[] = []) {
		const existing = this.panels.find(
			(p) =>
				p.kind === 'design' &&
				p.preset.projectId === projectId &&
				(!taskIds.length || (p.preset.taskIds as string[]).some((t) => taskIds.includes(t)))
		);
		if (existing) return this.focusPanel(existing.key);
		this.addPanel({ kind: 'design', id: null, preset: { projectId, taskIds } }, true);
	}

	/**
	 * Opens the sketch pad: a new sketch for a project, an existing one to draw over, or (for an idea that
	 * is not saved yet) a sketch handed back to the caller.
	 */
	openSketch(options: {
		projectId?: string | null;
		sketchId?: string | null;
		onsaved?: (png: Blob) => void;
	}) {
		const existing = options.sketchId
			? this.panels.find((p) => p.kind === 'sketch' && p.id === options.sketchId)
			: undefined;
		if (existing) return this.focusPanel(existing.key);
		this.addPanel({ kind: 'sketch', id: options.sketchId ?? null, preset: { ...options } }, true);
	}

	/** The send-to-printer window for a queued job. */
	openSend(jobId: string) {
		const existing = this.panels.find((p) => p.kind === 'send' && p.id === jobId);
		if (existing) return this.focusPanel(existing.key);
		this.addPanel({ kind: 'send', id: jobId, preset: {} });
	}

	/** The AI design window, optionally starting from a picture (e.g. a sketch) and a prompt. */
	openDesignWith(
		projectId: string,
		start: { image?: { mediaType: string; data: string; url: string }; prompt?: string }
	) {
		this.addPanel({ kind: 'design', id: null, preset: { projectId, taskIds: [], ...start } }, true);
	}

	private addPanel(p: Pick<Panel, 'kind' | 'id' | 'preset'>, expanded = false) {
		// Keep at most three open side by side: older ones fold down to their title bars.
		const open = this.panels.filter((x) => !x.minimized);
		const fold = open.length >= 3 ? open[0].key : null;
		this.panels = [
			...this.panels.map((x) =>
				x.key === fold
					? { ...x, minimized: true }
					: { ...x, expanded: expanded ? false : x.expanded }
			),
			{ ...p, key: `${p.kind}-${crypto.randomUUID()}`, title: '', minimized: false, expanded }
		];
	}
	focusPanel(key: string) {
		this.panels = this.panels.map((p) => (p.key === key ? { ...p, minimized: false } : p));
		requestAnimationFrame(() =>
			document
				.querySelector<HTMLElement>(`[data-panel="${key}"] input, [data-panel="${key}"] textarea`)
				?.focus()
		);
	}
	closePanel(key: string) {
		this.panels = this.panels.filter((p) => p.key !== key);
	}
	/** Changes one panel. Safe to call from effects: it does not subscribe to the panel list. */
	updatePanel(key: string, change: Partial<Panel>) {
		untrack(() => {
			const current = this.panels.find((p) => p.key === key);
			if (!current || Object.entries(change).every(([k, v]) => current[k as keyof Panel] === v))
				return;
			this.panels = this.panels.map((p) => (p.key === key ? { ...p, ...change } : p));
		});
	}

	setTheme(choice: string) {
		this.theme = choice;
		const light = matchMedia('(prefers-color-scheme: light)').matches;
		document.documentElement.dataset.theme =
			choice === 'auto' ? (light ? 'arctic' : 'holo') : choice;
		document.documentElement.dataset.themeChoice = choice;
		syncThemeColor();
		try {
			localStorage.setItem('print-lab-theme', choice);
		} catch {
			/* private mode: the choice lasts for this page only */
		}
	}
}

export class LabStore {
	ws = $state<Workspace>() as Workspace;
	printer = $state<PrinterStatus>({ configured: false });
	ai = $state({ configured: false, provider: 'claude-code', label: '' });
	/** Status of AI providers, Blender, OpenSCAD and the printer (loaded after start; the checks take a moment). */
	integrations = $state<IntegrationsReport | null>(null);
	/** Background tasks (AI designs and edits, Blender), newest first, kept live by the event stream. */
	tasks = $state<TaskInfo[]>([]);
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- bookkeeping, never rendered
	private waiters = new Map<string, ((t: TaskInfo) => void)[]>();
	checkingIntegrations = $state(false);
	online = $state(true);
	saving = $state(0);
	private source: EventSource | null = null;
	private refreshing: Promise<void> | null = null;
	/** Newest change the server has announced; the workspace is refreshed until it catches up. */
	private latestSeen = 0;
	private retryMs = 1000;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	/** Lookup tables rebuilt whenever the workspace changes. */
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- rebuilt by $derived, never mutated
	profiles = $derived(new Map(this.ws.profiles.map((p) => [p.id, p])));
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- rebuilt by $derived, never mutated
	projects = $derived(new Map(this.ws.projects.map((p) => [p.id, p])));
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- rebuilt by $derived, never mutated
	spools = $derived(new Map(this.ws.spools.map((s) => [s.id, s])));
	jobsByProject = $derived.by(() => {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- rebuilt by $derived, never mutated
		const map = new Map<string, Job[]>();
		for (const j of this.ws.jobs) {
			const list = map.get(j.projectId);
			if (list) list.push(j);
			else map.set(j.projectId, [j]);
		}
		return map;
	});
	/** Model version id → its model and version, for job cards and links. */
	versions = $derived.by(() => {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- rebuilt by $derived, never mutated
		const map = new Map<string, { m: ModelSummary; v: ModelVersionSummary }>();
		for (const m of this.ws.models) for (const v of m.versions) map.set(v.id, { m, v });
		return map;
	});

	constructor(
		initial: {
			workspace: Workspace;
			printer: PrinterStatus;
			ai: { configured: boolean; provider: string; label: string };
		},
		private ui: UiState
	) {
		this.ws = initial.workspace;
		this.printer = initial.printer;
		this.ai = initial.ai;
	}

	// ---------- Live sync ----------

	connect() {
		if (this.source || typeof EventSource === 'undefined') return;
		const source = new EventSource('/api/events');
		this.source = source;
		source.addEventListener('hello', (e) => {
			this.online = true;
			this.retryMs = 1000;
			const data = JSON.parse((e as MessageEvent).data);
			this.printer = data.printer;
			this.sampleTemps();
			if (data.tasks) {
				this.tasks = data.tasks;
				for (const t of data.tasks as TaskInfo[]) if (t.status !== 'running') this.settle(t);
			}
			this.announce(data.changeId);
		});
		source.addEventListener('change', (e) =>
			this.announce(JSON.parse((e as MessageEvent).data).changeId)
		);
		source.addEventListener('task', (e) => this.upsertTask(JSON.parse((e as MessageEvent).data)));
		source.addEventListener('task-removed', (e) => {
			const { id } = JSON.parse((e as MessageEvent).data);
			this.tasks = this.tasks.filter((t) => t.id !== id);
		});
		source.addEventListener('printer', (e) => {
			this.printer = JSON.parse((e as MessageEvent).data);
			this.sampleTemps();
		});
		source.onerror = () => {
			this.online = false;
			// The browser retries dropped connections itself, but gives up for good after an HTTP error.
			if (source.readyState === EventSource.CLOSED) {
				this.disconnect();
				this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
				this.retryMs = Math.min(this.retryMs * 2, 30_000);
			}
		};
	}

	disconnect() {
		clearTimeout(this.retryTimer);
		this.source?.close();
		this.source = null;
	}

	/** The server says the workspace is at `changeId`; fetch it unless we already have it. */
	private announce(changeId: number) {
		this.latestSeen = Math.max(this.latestSeen, changeId);
		// Our own write's response brings the new workspace; call() checks again when it is done.
		if (this.saving === 0 && changeId !== this.ws.changeId) void this.refresh();
	}

	refresh(): Promise<void> {
		if (this.refreshing) return this.refreshing;
		let fetched = -1;
		this.refreshing = fetch('/api/workspace')
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
			.then((ws: Workspace) => {
				fetched = ws.changeId;
				this.adopt(ws);
			})
			.catch(() => {})
			.finally(() => {
				this.refreshing = null;
				// Changes announced while this request was in flight need another look (only after a
				// successful fetch that is still behind, so a failing server is not hammered).
				if (fetched >= 0 && this.latestSeen > fetched) void this.refresh();
			});
		return this.refreshing;
	}

	/** Applies a workspace from a response, unless a newer one is already here. */
	adopt(ws: Workspace | undefined) {
		if (ws && ws.changeId >= this.ws.changeId) this.ws = ws;
	}

	/** Calls the API; applies the returned workspace; toasts on success or error. Returns the response body, or null on failure. */
	async call<T = Record<string, unknown>>(
		method: string,
		path: string,
		body?: unknown,
		success?: string
	): Promise<(T & { workspace?: Workspace }) | null> {
		this.saving++;
		try {
			const response = await fetch(path, {
				method,
				headers: body === undefined ? undefined : { 'content-type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body)
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok)
				throw new ApiError(data.error ?? `Request failed (${response.status}).`, response.status);
			this.adopt(data.workspace);
			if (success) this.ui.toast(success);
			return data;
		} catch (error) {
			const message =
				error instanceof ApiError
					? error.message
					: 'Could not reach the app server. Is it still running?';
			this.ui.toast(message, 'error');
			if (error instanceof ApiError && error.status === 409) void this.refresh();
			return null;
		} finally {
			this.saving--;
			if (this.saving === 0 && this.latestSeen > this.ws.changeId) void this.refresh();
		}
	}

	// ---------- Printer temperature history (kept in the browser, last 30 minutes) ----------

	temps = $state<
		{ t: number; nozzle: number | null; bed: number | null; chamber: number | null }[]
	>([]);
	private sampleTemps() {
		const s = this.printer.state;
		if (!s || (s.nozzle === null && s.bed === null)) return;
		const t = Date.now();
		const last = this.temps.at(-1);
		if (last && t - last.t < 2000) return;
		const keep = this.temps.filter((x) => t - x.t < 30 * 60_000);
		this.temps = [...keep, { t, nozzle: s.nozzle, bed: s.bed, chamber: s.chamber }];
	}

	// ---------- Background tasks ----------

	private upsertTask(task: TaskInfo) {
		const before = this.tasks.find((t) => t.id === task.id);
		this.tasks = before
			? this.tasks.map((t) => (t.id === task.id ? task : t))
			: [task, ...this.tasks];
		if (task.status === 'running') return;
		this.settle(task);
		// Finished while nobody was looking at it: say so.
		if (before?.status === 'running' && !this.ui.watching.has(task.id)) {
			if (task.status === 'done' && task.kind === 'ai-design')
				this.ui.toast(`✦ Design ready: “${task.title}”. Open Activity to review it.`);
			else if (task.status === 'done' && task.kind === 'ai-edit')
				this.ui.toast(`✦ Change ready for ${task.title.split(':')[0]}. Open Activity to keep it.`);
			else if (task.status === 'failed') this.ui.toast(`${task.title}: ${task.error}`, 'error');
		}
	}

	private settle(task: TaskInfo) {
		for (const resolve of this.waiters.get(task.id) ?? []) resolve(task);
		this.waiters.delete(task.id);
	}

	/** Resolves when the task finishes (from the event stream, with a slow poll in case it drops). */
	waitForTask(id: string): Promise<TaskInfo> {
		const known = this.tasks.find((t) => t.id === id);
		if (known && known.status !== 'running') return Promise.resolve(known);
		return new Promise((resolve) => {
			const poll = setInterval(async () => {
				const r = await fetch(`/api/tasks/${id}`).catch(() => null);
				if (r?.ok) {
					const t: TaskInfo = await r.json();
					if (t.status !== 'running') this.upsertTask(t);
				}
			}, 5000);
			this.waiters.set(id, [
				...(this.waiters.get(id) ?? []),
				(t) => {
					clearInterval(poll);
					resolve(t);
				}
			]);
		});
	}

	taskFor = (id: string | null | undefined) =>
		id ? this.tasks.find((t) => t.id === id) : undefined;
	tasksForProject = (projectId: string) => this.tasks.filter((t) => t.projectId === projectId);

	async taskAction(id: string, action: 'cancel' | 'dismiss') {
		const r = await fetch(`/api/tasks/${id}/${action}`, { method: 'POST' }).catch(() => null);
		if (action === 'dismiss' && r?.ok) this.tasks = this.tasks.filter((t) => t.id !== id);
	}

	async loadIntegrations(refresh = false) {
		if (this.checkingIntegrations) return;
		this.checkingIntegrations = true;
		try {
			const r = await fetch(`/api/integrations${refresh ? '?refresh=1' : ''}`);
			if (r.ok) this.integrations = await r.json();
		} catch {
			/* offline: keep the last report */
		} finally {
			this.checkingIntegrations = false;
		}
	}

	// ---------- Lookups ----------

	profile = (id: string | null | undefined): Profile | undefined =>
		id ? this.profiles.get(id) : undefined;
	project = (id: string | null | undefined): Project | undefined =>
		id ? this.projects.get(id) : undefined;
	spool = (id: string | null | undefined): Spool | undefined =>
		id ? this.spools.get(id) : undefined;
	jobsFor = (projectId: string): Job[] => this.jobsByProject.get(projectId) ?? [];

	ownedProjects(profile: string) {
		return this.ws.projects.filter((p) => profile === 'all' || p.profileId === profile);
	}

	/** The project list as filtered in the UI, pinned first; shared by the home grid and the sidebar. */
	listed(ui: UiState): Project[] {
		const q = ui.query.trim().toLowerCase();
		const items = this.ownedProjects(ui.profile).filter(
			(p) =>
				(ui.status === 'All' || p.status === ui.status) &&
				(!q ||
					`${p.title} ${p.description} ${p.category} ${p.notes} ${p.material}`
						.toLowerCase()
						.includes(q))
		);
		const order = ['Printing', 'Planned', 'Idea', 'Done'];
		const by: Record<UiState['sort'], (a: Project, b: Project) => number> = {
			updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
			created: (a, b) => b.createdAt.localeCompare(a.createdAt),
			name: (a, b) => a.title.localeCompare(b.title),
			progress: (a, b) =>
				order.indexOf(a.status) - order.indexOf(b.status) || b.updatedAt.localeCompare(a.updatedAt),
			person: (a, b) =>
				(this.profile(a.profileId)?.name ?? '').localeCompare(
					this.profile(b.profileId)?.name ?? ''
				) || b.updatedAt.localeCompare(a.updatedAt)
		};
		const sorted = [...items].sort(by[ui.sort]);
		return [...sorted.filter((p) => p.pinned), ...sorted.filter((p) => !p.pinned)];
	}

	// ---------- Printer-derived ----------

	get printerActive() {
		return (
			!!this.printer.connected &&
			!!this.printer.state &&
			ACTIVE_PRINTER_STATES.has(this.printer.state.gcodeState)
		);
	}

	/** Live printer data when this job is linked to the print that is running now. */
	liveFor(job: Job) {
		const s = this.printer.state;
		return this.printerActive && job.printerTask && s?.task === job.printerTask ? s : null;
	}

	/** 0..1 progress: live from the printer when linked, else estimated from start time and estimate. */
	progress(job: Job, now = Date.now()): number | null {
		if (job.status !== 'Printing') return null;
		const live = this.liveFor(job);
		if (live && live.percent !== null) return live.percent / 100;
		if (!job.startedAt || !job.minutes) return null;
		return Math.min(1, Math.max(0, (now - Date.parse(job.startedAt)) / (job.minutes * 60000)));
	}

	// ---------- Visualizer context ----------

	private stageOf(modelId: string, versionId: string | null, job?: Job): StageModel | null {
		const m = this.ws.models.find((x) => x.id === modelId);
		const v = versionId ?? m?.currentVersionId;
		if (!m || !v || !m.versions.some((x) => x.id === v)) return null;
		return {
			modelId: m.id,
			versionId: v,
			name: m.name,
			projectId: m.projectId,
			progress: job ? this.progress(job, this.ui.now) : null,
			live: !!(job && this.liveFor(job))
		};
	}
	private modelOfVersion(versionId: string) {
		return this.ws.models.find((m) => m.versions.some((v) => v.id === versionId));
	}

	/** A project's visualizer: its model on the printer if one of its jobs is printing, else its latest model. */
	stageFor(projectId: string): StageModel | null {
		const printing = this.ws.jobs.find(
			(j) => j.projectId === projectId && j.status === 'Printing' && j.modelVersionId
		);
		if (printing) {
			const m = this.modelOfVersion(printing.modelVersionId!);
			if (m) return this.stageOf(m.id, printing.modelVersionId, printing);
		}
		const latest = this.ws.models
			.filter((m) => m.projectId === projectId && m.currentVersionId)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
		return latest ? this.stageOf(latest.id, null) : null;
	}

	/** Whatever is printing now, if its job is linked to a model. */
	printingStage(): StageModel | null {
		const jobs = this.ws.jobs.filter((j) => j.status === 'Printing' && j.modelVersionId);
		const job = jobs.find((j) => this.liveFor(j)) ?? jobs[0];
		const m = job && this.modelOfVersion(job.modelVersionId!);
		return m ? this.stageOf(m.id, job.modelVersionId, job) : null;
	}

	/** Recently changed models (one per project), for the home page tour. */
	recentStages(limit = 6): StageModel[] {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local to this call
		const seen = new Set<string>();
		const out: StageModel[] = [];
		for (const m of [...this.ws.models].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
			if (seen.has(m.projectId) || !m.currentVersionId) continue;
			seen.add(m.projectId);
			const s = this.stageOf(m.id, null);
			if (s) out.push(s);
			if (out.length >= limit) break;
		}
		return out;
	}

	jobCost(job: Job) {
		const s = this.spool(job.spoolId);
		return s && s.cost !== null && job.grams !== null ? (job.grams * s.cost) / s.totalGrams : null;
	}
}

const KEY = Symbol('family-print-lab');
export interface AppContext {
	lab: LabStore;
	ui: UiState;
}
export const setApp = (app: AppContext) => setContext(KEY, app);
export const useApp = () => getContext<AppContext>(KEY);

/** Tints the phone's browser bar and status bar to match the active theme. */
export function syncThemeColor() {
	const bg = getComputedStyle(document.body).backgroundColor;
	document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
}
