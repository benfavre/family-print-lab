// HmsService: printer errors in plain words (offline database), the active alerts of a printer, their
// history (hms_events) and the buttons Bambu defines for them.
import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { DB } from '$lib/server/db';
import { hmsEvents } from '$lib/server/db/tables/hms';
import { printers as printers_ } from '$lib/server/db/tables/printers';
import type { Lab } from '$lib/server/lab';
import type { PrinterManager } from '$lib/server/printer/manager';
import type { BambuPrinter } from '$lib/server/printer/bambu';
import type { CommandOutcome } from '$lib/server/printer/commands/registry';
import { CANCEL_ERRORS } from '$lib/server/printer/diff';
import { AppError } from '$lib/server/validation';
import type { HmsAction, HmsService } from '$lib/server/modules/contracts';
import { PRINTER_MODELS, type ModelCode } from '$lib/shared/printers/models';
import type { HmsCode } from '$lib/shared/printers/status';
import {
	SEVERITY_ORDER,
	displayCode,
	hmsKeyOf,
	hmsModule,
	hmsSeverity,
	printErrorKey,
	printErrorModule,
	printErrorSeverity,
	type HmsAlert,
	type HmsActionView,
	type HmsEventRow,
	type HmsKind,
	type HmsSeverity
} from '$lib/shared/hms';
import { HmsDatabase } from './database';
import { ACTIONS, actionIdsFor, type ActionContext } from './actions';

export const UNKNOWN_TEXT = 'No description for this code yet. The Bambu Lab wiki may know it.';

/** An alert as the server builds it: the API shape, with commands typed for the HmsInfo contract. */
export type HmsAlertInfo = Omit<HmsAlert, 'actions'> & { actions: (HmsActionView & HmsAction)[] };

export interface HmsModuleService extends HmsService {
	describe(code: HmsCode | number, printerId: string): HmsAlertInfo;
	active(printerId: string): HmsAlertInfo[];
	/** A code on no particular printer (or on a model): for the lookup box. */
	lookup(kind: HmsKind, key: string, o?: { printerId?: string; model?: ModelCode }): HmsAlertInfo;
	history(
		printerId: string,
		o?: { severity?: HmsSeverity[]; limit?: number; offset?: number }
	): { rows: HmsEventRow[]; total: number };
	/** Errors recorded while a job printed, newest first. */
	forJob(jobId: string): HmsEventRow[];
	runAction(printerId: string, code: string, actionId: number): Promise<CommandOutcome>;
	database(): HmsDatabase | null;
}

type Raw = Record<string, unknown>;

/**
 * The report fields Bambu's error buttons carry (`job_id`, `subtask_id`, `job_attr`) are not in
 * PrinterSnapshot, and rawReport() redacts ids, so they are read from the printer's merged report.
 * A foundation gap (noted in the hms report): PrinterSnapshot should carry them.
 */
function reportFields(printer: BambuPrinter): {
	jobId: string;
	subtaskId: string;
	jobAttr: number;
} {
	const raw = ((printer as unknown as { raw?: Raw }).raw ?? {}) as Raw;
	const str = (v: unknown) =>
		typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, 40) : '';
	return {
		jobId: str(raw.job_id),
		subtaskId: str(raw.subtask_id),
		jobAttr: typeof raw.job_attr === 'number' ? raw.job_attr : 0
	};
}

const uuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

export function createHmsService(deps: {
	db: DB;
	lab: Lab;
	printers: PrinterManager;
	database: HmsDatabase | null;
	onChange?: (printerId: string) => void;
}): HmsModuleService & {
	raised(printerId: string, kind: HmsKind, key: string, jobId: string | null): void;
	cleared(printerId: string, kind: HmsKind, key: string): void;
	reconcile(printerId: string, keys: { kind: HmsKind; key: string }[]): void;
} {
	const { db, printers, database } = deps;

	/**
	 * The device prefix whose texts apply: the serial's first three characters when the database has
	 * texts for them (Bambu Studio HMS.cpp get_dev_id_type), else the catalogue's (simulated printers
	 * have made-up serials).
	 */
	function deviceOf(printerId?: string, model?: ModelCode): string | null {
		const p = printerId ? printers.get(printerId) : undefined;
		const prefix = p?.config.serial.slice(0, 3).toUpperCase();
		if (prefix && database?.knowsDevice(prefix)) return prefix;
		const code = p?.model.code ?? model;
		return code ? (PRINTER_MODELS[code]?.hmsDevice ?? null) : null;
	}

	function build(kind: HmsKind, key: string, device: string | null): HmsAlertInfo {
		const raw =
			key.length === 16
				? { attr: parseInt(key.slice(0, 8), 16), code: parseInt(key.slice(8), 16) }
				: null;
		const error = kind === 'print_error' ? parseInt(key, 16) : 0;
		const text = database?.text(kind, key, device) ?? null;
		const image = database?.image(key, device) ?? null;
		return {
			key,
			code: displayCode(key),
			kind,
			severity: kind === 'hms' ? hmsSeverity(raw?.code ?? null) : printErrorSeverity(error),
			module: kind === 'hms' ? hmsModule(raw?.attr ?? null) : printErrorModule(error),
			text: text || UNKNOWN_TEXT,
			known: !!text,
			wikiUrl: database?.wikiUrl(kind, key, device) ?? null,
			actions: actionIdsFor(kind, key, database?.actions(key, device) ?? []).map((id) => ({
				id,
				label: ACTIONS[id].label,
				command: ACTIONS[id].steps[0].name,
				risk: ACTIONS[id].risk
			})),
			image: image ? `/api/hms/image/${image}` : null
		};
	}

	function describe(code: HmsCode | number, printerId: string): HmsAlertInfo {
		const device = deviceOf(printerId);
		return typeof code === 'number'
			? build('print_error', printErrorKey(code), device)
			: build('hms', hmsKeyOf(code), device);
	}

	/** A print error worth showing: not a cancel, and not one Bambu keeps internal (empty text). */
	function reportable(error: number, device: string | null) {
		if (!error || CANCEL_ERRORS.has(error)) return false;
		return database?.text('print_error', printErrorKey(error), device) !== '';
	}

	function active(printerId: string): HmsAlertInfo[] {
		const s = printers.get(printerId)?.snapshot;
		if (!s) return [];
		const device = deviceOf(printerId);
		const out = new Map<string, HmsAlertInfo>();
		if (reportable(s.printError, device)) {
			const a = build('print_error', printErrorKey(s.printError), device);
			out.set(a.key, a);
		}
		for (const h of s.hms) {
			const a = build('hms', hmsKeyOf(h), device);
			out.set(a.key, a);
		}
		return [...out.values()].sort(
			(a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
		);
	}

	const rowOut = (r: typeof hmsEvents.$inferSelect): HmsEventRow => ({
		id: r.id,
		printerId: r.printerId,
		kind: r.kind,
		code: r.code,
		severity: r.severity,
		text: r.text,
		raisedAt: r.raisedAt,
		clearedAt: r.clearedAt,
		jobId: r.jobId
	});
	const known = (printerId: string) =>
		!!db.select({ id: printers_.id }).from(printers_).where(eq(printers_.id, printerId)).get();

	function raised(printerId: string, kind: HmsKind, key: string, jobId: string | null) {
		if (!known(printerId)) return;
		const open = db
			.select()
			.from(hmsEvents)
			.where(
				and(
					eq(hmsEvents.printerId, printerId),
					eq(hmsEvents.kind, kind),
					eq(hmsEvents.code, key),
					isNull(hmsEvents.clearedAt)
				)
			)
			.get();
		if (open) {
			if (jobId && !open.jobId)
				db.update(hmsEvents).set({ jobId }).where(eq(hmsEvents.id, open.id)).run();
			return;
		}
		const a = build(kind, key, deviceOf(printerId));
		db.insert(hmsEvents)
			.values({
				id: uuid(),
				printerId,
				kind,
				code: key,
				severity: a.severity,
				text: a.known ? a.text : '',
				raisedAt: nowIso(),
				jobId
			})
			.run();
		deps.onChange?.(printerId);
	}

	function cleared(printerId: string, kind: HmsKind, key: string) {
		const done = db
			.update(hmsEvents)
			.set({ clearedAt: nowIso() })
			.where(
				and(
					eq(hmsEvents.printerId, printerId),
					eq(hmsEvents.kind, kind),
					eq(hmsEvents.code, key),
					isNull(hmsEvents.clearedAt)
				)
			)
			.run();
		if (done.changes) deps.onChange?.(printerId);
	}

	/** Closes open rows the printer no longer reports (it cleared them while the app was away). */
	function reconcile(printerId: string, keys: { kind: HmsKind; key: string }[]) {
		const still = new Set(keys.map((k) => `${k.kind}:${k.key}`));
		const stale = db
			.select({ id: hmsEvents.id, kind: hmsEvents.kind, code: hmsEvents.code })
			.from(hmsEvents)
			.where(and(eq(hmsEvents.printerId, printerId), isNull(hmsEvents.clearedAt)))
			.all()
			.filter((r) => !still.has(`${r.kind}:${r.code}`));
		if (!stale.length) return;
		db.update(hmsEvents)
			.set({ clearedAt: nowIso() })
			.where(
				inArray(
					hmsEvents.id,
					stale.map((r) => r.id)
				)
			)
			.run();
		deps.onChange?.(printerId);
	}

	return {
		describe,
		active,
		lookup(kind, key, o = {}) {
			return build(kind, key, deviceOf(o.printerId, o.model));
		},
		history(printerId, o = {}) {
			const where = and(
				eq(hmsEvents.printerId, printerId),
				o.severity?.length ? inArray(hmsEvents.severity, o.severity) : undefined
			);
			const rows = db
				.select()
				.from(hmsEvents)
				.where(where)
				.orderBy(desc(hmsEvents.raisedAt))
				.limit(Math.min(Math.max(o.limit ?? 50, 1), 200))
				.offset(Math.max(o.offset ?? 0, 0))
				.all()
				.map(rowOut);
			const total = db.select({ n: count() }).from(hmsEvents).where(where).get()?.n ?? 0;
			return { rows, total };
		},
		forJob(jobId) {
			return db
				.select()
				.from(hmsEvents)
				.where(eq(hmsEvents.jobId, jobId))
				.orderBy(desc(hmsEvents.raisedAt))
				.limit(20)
				.all()
				.map(rowOut);
		},
		async runAction(printerId, code, actionId) {
			const printer = printers.require(printerId);
			const key = code.replace(/[\s_-]/g, '').toUpperCase();
			const alert = active(printerId).find((a) => a.key === key);
			if (!alert) throw new AppError(409, 'That alert is no longer active on the printer.');
			if (!alert.actions.some((a) => a.id === actionId))
				throw new AppError(400, 'That button does not belong to this alert.');
			const def = ACTIONS[actionId];
			const fields = reportFields(printer);
			if (def.printerOnlyForProcessing && ((fields.jobAttr >> 4) & 0xf) > 1)
				throw new AppError(
					409,
					'For safety, this kind of task (such as laser cutting) can only be resumed on the printer.'
				);
			const ctx: ActionContext = {
				printError: parseInt(alert.key, 16),
				jobId: fields.jobId,
				subtaskId: fields.subtaskId
			};
			let outcome: CommandOutcome = { outcome: 'sent' };
			for (const step of def.steps)
				outcome = await printer.send(step.name, step.params(ctx) as never);
			return outcome;
		},
		database: () => database,
		raised,
		cleared,
		reconcile
	};
}
