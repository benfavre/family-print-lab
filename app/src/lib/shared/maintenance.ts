// The maintenance tracker's shapes (server module modules/maintenance, its API and UI) and the pure
// rules both sides use: when a task is due, and what a nozzle's type code means.

/** 'ok', 'soon' (85 % of an interval used), 'due' (an interval reached), 'manual' (no interval set). */
export type DueState = 'ok' | 'soon' | 'due' | 'manual';

export interface MaintenanceTask {
	id: string;
	printerId: string;
	kind: string;
	label: string;
	intervalHours: number | null;
	intervalDays: number | null;
	lastDoneAt: string | null;
	lastDoneHours: number | null;
	notes: string;
	/** The Bambu Lab wiki page a default task comes from. */
	source: string | null;
	createdAt: string;
}

export interface MaintenanceTaskView extends MaintenanceTask {
	due: DueInfo;
}

export interface DueInfo {
	state: DueState;
	/** Which interval decided the state (the one furthest along). */
	by: 'hours' | 'days' | null;
	/** 0–1+ of the interval furthest along; null without intervals. */
	progress: number | null;
	/** Print hours left (negative when overdue); null without an hours interval. */
	hoursLeft: number | null;
	/** Days left (negative when overdue); null without a days interval. */
	daysLeft: number | null;
}

export interface MaintenanceLogEntry {
	id: string;
	taskId: string | null;
	kind: string;
	label: string;
	doneAt: string;
	hoursAt: number | null;
	note: string;
}

export interface Odometer {
	/** Print hours from finished jobs on this printer. */
	jobHours: number;
	baselineHours: number;
	/** jobHours + baselineHours. */
	totalHours: number;
}

/** A nozzle on an H2C hotend rack (device.nozzle.info[] entries with id 0x10–0x1F). */
export interface RackNozzle {
	/** 0-based rack position (id & 0xF). */
	slot: number;
	diameter: number | null;
	type: string | null;
	wear: number | null;
	/** color_m as '#rrggbb', null when unset. */
	color: string | null;
}

export interface HotendRack {
	/** device.holder.stat, labelled (Bambu Studio DevNozzleRack.h RackStatus). */
	status: string | null;
	/** device.holder.pos, labelled (RackPos). */
	position: string | null;
	nozzles: RackNozzle[];
}

export interface MaintenanceOverview {
	printerId: string;
	odometer: Odometer;
	tasks: MaintenanceTaskView[];
	log: MaintenanceLogEntry[];
	/** The rack on an H2C when it reports one; null otherwise. */
	rack: HotendRack | null;
	/** The model's firmware release notes on the Bambu Lab wiki. */
	releaseNotes: string | null;
	/** Whether this printer takes system.set_accessories (single-nozzle printers). */
	canSetNozzle: boolean;
}

/** Share of an interval used before a task counts as due soon. */
export const SOON = 0.85;

/**
 * Where a task stands. The counters start at the last time it was done (or when it was added, so a
 * new task never starts overdue); the interval furthest along decides.
 */
export function dueInfo(
	task: Pick<
		MaintenanceTask,
		'intervalHours' | 'intervalDays' | 'lastDoneAt' | 'lastDoneHours' | 'createdAt'
	>,
	odometerHours: number,
	now: Date = new Date()
): DueInfo {
	const hoursInterval = task.intervalHours && task.intervalHours > 0 ? task.intervalHours : null;
	const daysInterval = task.intervalDays && task.intervalDays > 0 ? task.intervalDays : null;
	if (hoursInterval === null && daysInterval === null)
		return { state: 'manual', by: null, progress: null, hoursLeft: null, daysLeft: null };
	let hoursLeft: number | null = null;
	let daysLeft: number | null = null;
	let hoursProgress = -1;
	let daysProgress = -1;
	if (hoursInterval !== null) {
		const used = Math.max(0, odometerHours - (task.lastDoneHours ?? 0));
		hoursLeft = round1(hoursInterval - used);
		hoursProgress = used / hoursInterval;
	}
	if (daysInterval !== null) {
		const from = Date.parse(task.lastDoneAt ?? task.createdAt);
		const days = Number.isFinite(from) ? Math.max(0, (now.getTime() - from) / 86_400_000) : 0;
		daysLeft = round1(daysInterval - days);
		daysProgress = days / daysInterval;
	}
	const by = hoursProgress >= daysProgress ? 'hours' : 'days';
	const progress = Math.max(hoursProgress, daysProgress);
	return {
		state: progress >= 1 ? 'due' : progress >= SOON ? 'soon' : 'ok',
		by,
		progress: Math.round(progress * 1000) / 1000,
		hoursLeft,
		daysLeft
	};
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Due first, then soon, then ok, then manual; furthest along first within a state. */
export function byUrgency(a: MaintenanceTaskView, b: MaintenanceTaskView) {
	const rank = { due: 0, soon: 1, ok: 2, manual: 3 } as const;
	return rank[a.due.state] - rank[b.due.state] || (b.due.progress ?? 0) - (a.due.progress ?? 0);
}

/** How a task is due, in plain words ("Due in 12 days", "3 print hours overdue", "When needed"). */
export function dueLabel(due: DueInfo): string {
	if (due.state === 'manual') return 'When needed';
	const left = due.by === 'hours' ? due.hoursLeft : due.daysLeft;
	if (left === null) return '';
	const unit = (n: number) =>
		due.by === 'hours'
			? `${fmt(n)} print ${n === 1 ? 'hour' : 'hours'}`
			: `${fmt(n)} ${n === 1 ? 'day' : 'days'}`;
	if (left <= 0) return left === 0 ? 'Due now' : `${unit(-left)} overdue`;
	return `Due in ${unit(left)}`;
}

const fmt = (n: number) => (n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10));

/** "Every 30 days or 200 print hours", "When needed". */
export function intervalLabel(t: Pick<MaintenanceTask, 'intervalHours' | 'intervalDays'>) {
	const parts = [
		t.intervalDays ? `${t.intervalDays} ${t.intervalDays === 1 ? 'day' : 'days'}` : '',
		t.intervalHours ? `${fmt(t.intervalHours)} print hours` : ''
	].filter(Boolean);
	return parts.length ? `Every ${parts.join(' or ')}` : 'When needed';
}

const MATERIALS: Record<string, string> = {
	'00': 'stainless steel',
	'01': 'hardened steel',
	'05': 'tungsten carbide'
};
const FLOWS: Record<string, string> = {
	S: 'standard flow',
	A: 'standard flow',
	X: 'standard flow',
	H: 'high flow',
	E: 'high flow',
	U: 'TPU high flow',
	B: 'E3D high flow'
};

/**
 * A nozzle's type in words. Older printers report 'stainless_steel' / 'hardened_steel'; newer ones a
 * code like 'HS01' where the 2nd letter is the flow and the last two digits the material (Bambu Studio
 * v02.08.02.61 DeviceCore/DevNozzleSystem.cpp s_parse_nozzle_type, _str2_nozzle_flow_type,
 * _str2_nozzle_type). Unknown codes come back as they are.
 */
export function nozzleTypeLabel(type: string | null | undefined): string {
	if (!type || type === 'N/A') return 'Unknown';
	if (type === 'stainless_steel') return 'Stainless steel';
	if (type === 'hardened_steel') return 'Hardened steel';
	if (type.length >= 4) {
		const material = MATERIALS[type.slice(2, 4)];
		const flow = FLOWS[type.slice(1, 2)];
		if (material) {
			const text = flow ? `${material}, ${flow}` : material;
			return text[0].toUpperCase() + text.slice(1);
		}
	}
	return type;
}

/** Nozzle types system.set_accessories takes (OpenBambuAPI mqtt.md "system.set_accessories.nozzle"). */
export const ACCESSORY_NOZZLE_TYPES = ['stainless_steel', 'hardened_steel'] as const;
export type AccessoryNozzleType = (typeof ACCESSORY_NOZZLE_TYPES)[number];
/** Bambu nozzle sizes (Bambu Studio DeviceCore/DevDefs.h NozzleDiameterType: 0.2, 0.4, 0.6, 0.8 mm). */
export const NOZZLE_DIAMETERS = [0.2, 0.4, 0.6, 0.8] as const;
