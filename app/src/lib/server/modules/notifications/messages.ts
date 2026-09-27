// Lab events → notification messages (pure): which events are worth telling, the placeholder values
// for the templates, and the level, link and privacy flags that routing needs.
import { stageName } from '$lib/shared/printers/stages';
import type { HmsCode } from '$lib/shared/printers/status';
import {
	eventDef,
	HMS_SEVERITIES,
	type HmsSeverityName,
	type NotifyLevel,
	type Template,
	type TemplateVar
} from '$lib/shared/notifications';

/** What building a message needs to know about the lab. */
export interface Lookups {
	printerName(id: string): string | null;
	/** The printer's current print, if it reports one. */
	printerState(id: string): { task: string; percent: number | null } | null;
	/** A job's project title and, when a kid's profile owns it, that profile's display name. */
	job(id: string): { title: string; kid: string | null } | null;
	project(id: string): { title: string; kid: string | null } | null;
	profile(id: string): { name: string } | null;
	/** Plain words for an alert (the hms package when present, else the code). */
	hms(code: HmsCode, printerId: string): { text: string; severity: HmsSeverityName | 'unknown' };
	printError(code: number, printerId: string): string;
}

export interface Message {
	event: string;
	level: NotifyLevel;
	title: string;
	body: string;
	printerId: string | null;
	jobId: string | null;
	link: string | null;
	at: string;
	/** The event's own data (for webhooks). */
	data: Record<string, unknown>;
	/** About a kid's print or request (pictures need the parent's say-so). */
	kidJob: boolean;
	/** Printer alerts: how serious. */
	hmsSeverity: HmsSeverityName | 'unknown' | null;
	/** Same key within a few minutes → told once. */
	dedupe: string | null;
}

/** Replaces {{name}} placeholders; unknown or empty ones become nothing, spaces tidied. */
export function render(template: string, vars: Partial<Record<TemplateVar, string>>): string {
	return template
		.replace(/\{\{\s*([a-z]+)\s*\}\}/g, (_, name: string) => vars[name as TemplateVar] ?? '')
		.replace(/[ \t]{2,}/g, ' ')
		.replace(/ ([.,:;!?])/g, '$1')
		.trim();
}

/** HMS code as Bambu shows it, e.g. 0700_0200_0002_0001. */
export const hmsText = (h: HmsCode) =>
	[(h.attr ?? 0) >>> 16, (h.attr ?? 0) & 0xffff, (h.code ?? 0) >>> 16, (h.code ?? 0) & 0xffff]
		.map((n) => n.toString(16).toUpperCase().padStart(4, '0'))
		.join('_');

/** Severity from the code's high word (1 fatal, 2 serious, 3 common, 4 info; PLAN.md 8.5). */
export function hmsSeverity(h: HmsCode): HmsSeverityName | 'unknown' {
	return HMS_SEVERITIES[((h.code ?? 0) >>> 16) - 1] ?? 'unknown';
}

const PAUSE_WORDS: Record<string, string> = {
	user: 'Paused by the user',
	error: 'Paused because of a problem',
	filament: 'Paused: filament ran out',
	other: 'Paused'
};

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const percentText = (p: number | null | undefined) =>
	p === null || p === undefined ? '' : `${Math.round(p)} %`;

/**
 * The message for one event, or null when it is not worth telling (unknown to the catalogue, or a
 * filament pause, which ams.runout already covers).
 */
export function buildMessage(
	event: { name: string; data: Record<string, unknown> },
	lookups: Lookups,
	templates: Record<string, Template>
): Message | null {
	const def = eventDef(event.name);
	if (!def || def.name === 'other') return null;
	const d = event.data;
	if (event.name === 'print.paused' && d.reason === 'filament') return null;

	const printerId = str(d.printerId) || null;
	const jobId = str(d.jobId) || null;
	const state = printerId ? lookups.printerState(printerId) : null;
	const job = jobId ? lookups.job(jobId) : null;
	const task = str(d.task) || state?.task || '';
	const vars: Partial<Record<TemplateVar, string>> = {
		printer: str(d.printerName) || (printerId && lookups.printerName(printerId)) || 'The printer',
		task: task || job?.title || 'The print',
		job: job?.title || task || 'the print',
		percent: percentText(
			typeof d.percent === 'number'
				? d.percent
				: event.name === 'print.finished'
					? 100
					: state?.percent
		),
		kid: job?.kid ?? ''
	};
	let level = def.level;
	let kidJob = !!job?.kid;
	let severity: Message['hmsSeverity'] = null;
	let dedupe: string | null = null;
	let link: string | null = printerId ? `/printers/${printerId}` : null;

	switch (event.name) {
		case 'print.failed': {
			const code = typeof d.printError === 'number' ? d.printError : 0;
			const hms = Array.isArray(d.hms) ? (d.hms as HmsCode[]) : [];
			vars.error =
				(code && printerId ? lookups.printError(code, printerId) : '') ||
				(hms[0] && printerId ? lookups.hms(hms[0], printerId).text : '') ||
				'The printer reported a problem.';
			break;
		}
		case 'print.paused':
			vars.error =
				typeof d.stage === 'number' && d.stage >= 0
					? stageName(d.stage)
					: (PAUSE_WORDS[str(d.reason)] ?? 'Paused');
			if (d.reason === 'user') level = 'info';
			break;
		case 'hms.raised': {
			const code = d.hms as HmsCode;
			const info = printerId
				? lookups.hms(code, printerId)
				: { text: '', severity: hmsSeverity(code) };
			severity = info.severity === 'unknown' ? hmsSeverity(code) : info.severity;
			vars.error = info.text || `Alert ${hmsText(code)}`;
			level =
				severity === 'fatal' || severity === 'serious'
					? 'error'
					: severity === 'info'
						? 'info'
						: 'warning';
			dedupe = `hms:${printerId}:${hmsText(code)}`;
			break;
		}
		case 'printer.offline':
			vars.error = str(d.error);
			dedupe = `offline:${printerId}`;
			break;
		case 'request.created': {
			const profile = lookups.profile(str(d.profileId));
			const project = lookups.project(str(d.projectId));
			vars.kid = profile?.name ?? 'A kid';
			vars.job = project?.title ?? 'something';
			kidJob = true;
			link = '/family#requests';
			break;
		}
		default:
			// Events from packages (queue, maintenance, AI checks): their common fields.
			vars.error = str(d.reason) || str(d.error) || str(d.message);
			if (!task) vars.task = str(d.label) || str(d.title) || vars.task;
	}

	const template = templates[event.name] ?? def.template;
	const title = render(template.title, vars) || render(def.template.title, vars);
	return {
		event: event.name,
		level,
		title: title.slice(0, 200),
		body: render(template.body, vars).slice(0, 1000),
		printerId,
		jobId,
		link,
		at: str(d.at) || new Date().toISOString(),
		data: Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'at')),
		kidJob,
		hmsSeverity: severity,
		dedupe
	};
}
