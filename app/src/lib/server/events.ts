// The lab's event bus: typed events about printers, prints, alerts, trays and kids' requests. The
// PrinterManager derives printer events from status changes (printer/diff.ts); Lab emits request
// events; packages add their own by declaration merging in their files:
//
//   declare module '$lib/server/events' {
//   	interface LabEventMap {
//   		'maintenance.due': { printerId: string; taskId: string };
//   	}
//   }
//
// Names are `<area>.<what>`. Reserved for packages: queue.*, maintenance.*, power.*, camera.*,
// spool.*, kid.*, notification.*, vision.*.
// Ordering: emit() calls listeners synchronously in registration order, and the runtime registers its
// own listeners (job linking and closing) before any module starts, so a module's print.finished
// listener sees the job already closed. Listeners that need async work must not block (fire and
// forget with their own error handling); a throwing listener is logged and never reaches the emitter.
import type { GlobalTray, HmsCode, PrinterTray } from '$lib/shared/printers/status';

/** ISO time, set by emit(). */
export interface EventBase {
	at: string;
}
export interface PrintRef {
	printerId: string;
	printerName: string;
	jobId: string | null;
	task: string;
}

export interface LabEventMap {
	'printer.online': { printerId: string; printerName: string };
	'printer.offline': { printerId: string; printerName: string; error: string };
	'print.started': PrintRef;
	'print.paused': PrintRef & {
		reason: 'user' | 'error' | 'filament' | 'other';
		stage: number | null;
	};
	'print.resumed': PrintRef;
	/** On each layer change. */
	'print.layer': PrintRef & { layer: number; totalLayers: number | null; percent: number | null };
	'print.finished': PrintRef & { minutes: number | null };
	'print.failed': PrintRef & { printError: number; hms: HmsCode[] };
	'print.cancelled': PrintRef;
	'hms.raised': { printerId: string; printerName: string; hms: HmsCode };
	'hms.cleared': { printerId: string; printerName: string; hms: HmsCode };
	/** Stage 6 "paused: filament ran out" (the hms package may add code-based detection). */
	'ams.runout': { printerId: string; printerName: string; tray: GlobalTray | null };
	'ams.tray.changed': {
		printerId: string;
		printerName: string;
		tray: GlobalTray;
		before: PrinterTray | null;
		after: PrinterTray | null;
	};
	/** Emitted by the queue package. */
	'queue.changed': { printerId: string | null; reason: string };
	/** A kid asked to print (emitted by Lab after commit). */
	'request.created': { requestId: string; profileId: string; projectId: string };
	'request.decided': { requestId: string; decision: 'approve' | 'decline'; jobId: string | null };
}
export type LabEventName = keyof LabEventMap;
export type LabEvent<K extends LabEventName = LabEventName> = {
	name: K;
	data: LabEventMap[K] & EventBase;
};

type Listener = (data: never) => void;

export class EventBus {
	private listeners = new Map<string, Listener[]>();
	private any: ((event: LabEvent) => void)[] = [];
	private history: LabEvent[] = [];

	constructor(private log: (message: string) => void = console.error) {}

	on<K extends LabEventName>(name: K, fn: (data: LabEventMap[K] & EventBase) => void): () => void {
		const list = this.listeners.get(name) ?? [];
		list.push(fn as Listener);
		this.listeners.set(name, list);
		return () => {
			const now = this.listeners.get(name) ?? [];
			this.listeners.set(
				name,
				now.filter((f) => f !== fn)
			);
		};
	}

	onAny(fn: (event: LabEvent) => void): () => void {
		this.any.push(fn);
		return () => (this.any = this.any.filter((f) => f !== fn));
	}

	emit<K extends LabEventName>(name: K, data: LabEventMap[K]): void {
		const event = { name, data: { ...data, at: new Date().toISOString() } } as LabEvent<K>;
		this.history.push(event as LabEvent);
		if (this.history.length > 200) this.history.splice(0, this.history.length - 200);
		for (const fn of [...(this.listeners.get(name) ?? [])])
			try {
				(fn as (d: typeof event.data) => void)(event.data);
			} catch (error) {
				this.log(`[print-lab] ${name} listener failed: ${(error as Error).message}`);
			}
		for (const fn of [...this.any])
			try {
				fn(event as LabEvent);
			} catch (error) {
				this.log(`[print-lab] ${name} listener failed: ${(error as Error).message}`);
			}
	}

	/** Last 200 events, newest last (for the notification centre's first load and tests). */
	recent(): LabEvent[] {
		return [...this.history];
	}
}
