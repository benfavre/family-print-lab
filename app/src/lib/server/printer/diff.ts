// Printer status changes → lab events (pure). The PrinterManager calls this on every update and emits
// the result on the bus.
import type { LabEvent, LabEventMap, LabEventName, PrintRef } from '../events';
import {
	ACTIVE_PRINTER_STATES,
	type HmsCode,
	type PrinterSnapshot,
	type PrinterStatus,
	type PrinterTray
} from '$lib/shared/printers/status';

/**
 * Print errors that mean "cancelled", not "failed": 0300400C "The task was canceled." and 0500400E
 * "Printing was cancelled." (Bambu Studio resources/hms/hms_en_094.json, device_error).
 */
export const CANCEL_ERRORS = new Set([0x0300400c, 0x0500400e]);

const active = (s: PrinterSnapshot | null | undefined) =>
	!!s && ACTIVE_PRINTER_STATES.has(s.gcodeState);
const hmsKey = (h: HmsCode) => `${h.attr ?? ''}:${h.code ?? ''}`;
/** Paused-for-what from the stage (ha-bambulab const.py CURRENT_STAGE_IDS). */
function pauseReason(stage: number | null): LabEventMap['print.paused']['reason'] {
	if (stage === 16) return 'user';
	if (stage === 6) return 'filament';
	if (stage === null || stage === 5 || stage === 30 || stage === 0 || stage === 255 || stage === -1)
		return 'other';
	return 'error';
}
/** What counts as a tray change: type, colour, RFID uuid, remaining in 5 % steps. */
const trayKey = (t: PrinterTray | null) =>
	t
		? `${t.type}|${t.color}|${t.trayUuid}|${t.remain === null ? '' : Math.round(t.remain / 5)}`
		: '';
function trays(s: PrinterSnapshot): Map<number, PrinterTray> {
	const out = new Map<number, PrinterTray>();
	for (const unit of s.ams) for (const t of unit.trays) out.set(t.global, t);
	for (const t of s.externalSpools) out.set(t.global, t);
	return out;
}

export function diffStatus(
	printer: { id: string; name: string },
	prev: PrinterStatus | null,
	next: PrinterStatus,
	jobIdFor: (task: string) => string | null
): LabEvent[] {
	const events: LabEvent[] = [];
	const at = new Date().toISOString();
	const push = <K extends LabEventName>(name: K, data: LabEventMap[K]) =>
		events.push({ name, data: { ...data, at } } as unknown as LabEvent);
	const who = { printerId: printer.id, printerName: printer.name };

	if (!!prev?.connected !== !!next.connected) {
		if (next.connected) push('printer.online', who);
		else if (prev?.connected)
			push('printer.offline', { ...who, error: next.error || 'The printer went offline.' });
	}

	const before = prev?.state ?? null;
	const after = next.state ?? null;
	if (!after) return events;
	const task = after.task || before?.task || '';
	const ref = (): PrintRef => ({ ...who, jobId: task ? jobIdFor(task) : null, task });
	const was = before?.gcodeState ?? '';
	const now = after.gcodeState;

	if (!active(before) && active(after)) push('print.started', ref());
	if (active(before) && !active(after)) {
		if (now === 'FINISH') push('print.finished', { ...ref(), minutes: null });
		else if (now === 'FAILED') {
			if (CANCEL_ERRORS.has(after.printError)) push('print.cancelled', ref());
			else push('print.failed', { ...ref(), printError: after.printError, hms: after.hms });
		} else if (now === 'IDLE') push('print.cancelled', ref());
	}
	if (was !== 'PAUSE' && now === 'PAUSE' && before) {
		const stage = after.stage.id;
		push('print.paused', { ...ref(), reason: pauseReason(stage), stage });
		if (stage === 6) push('ams.runout', { ...who, tray: before.activeTray ?? after.activeTray });
	}
	if (was === 'PAUSE' && (now === 'RUNNING' || now === 'PREPARE')) push('print.resumed', ref());
	if (active(after) && after.layer !== null && after.layer !== (before?.layer ?? null) && before)
		push('print.layer', {
			...ref(),
			layer: after.layer,
			totalLayers: after.totalLayers,
			percent: after.percent
		});

	// Alerts by attr+code.
	const had = new Map((before?.hms ?? []).map((h) => [hmsKey(h), h]));
	const has = new Map(after.hms.map((h) => [hmsKey(h), h]));
	for (const [key, h] of has) if (!had.has(key)) push('hms.raised', { ...who, hms: h });
	for (const [key, h] of had) if (!has.has(key)) push('hms.cleared', { ...who, hms: h });

	// Trays, only once there is something to compare with.
	if (before) {
		const old = trays(before);
		const fresh = trays(after);
		for (const tray of new Set([...old.keys(), ...fresh.keys()])) {
			const a = old.get(tray) ?? null;
			const b = fresh.get(tray) ?? null;
			if (trayKey(a) !== trayKey(b))
				push('ams.tray.changed', { ...who, tray, before: a, after: b });
		}
	}
	return events;
}
