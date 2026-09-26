// Server modules: how feature packages plug into the app without editing it. Each package adds
// src/lib/server/modules/<key>/module.ts exporting `defineModule({...})` as default; the runtime finds
// them with import.meta.glob, starts them in `order` (a module that fails to start logs and stays off;
// the app still boots) and stops them in reverse order. A module gets a ModuleContext (database, lab,
// bus, printers, tasks, hooks, live channels, its own settings) and may return a service that others
// reach through ctx.module(key) / rt.module(key): declare it by declaration merging in module.ts:
//
//   declare module '$lib/server/modules' {
//   	interface ModuleServices {
//   		camera: CameraService;
//   	}
//   }
import type { z } from 'zod';
import type { DB } from './db';
import type { Lab } from './lab';
import type { EventBus } from './events';
import type { PrinterManager } from './printer/manager';
import type { TaskCenter } from './tasks';
import type { PrintFiles } from './printing';
import type { ModelStore } from './models';
import type { SettingsStore } from './module-settings';
import type { IntegrationStatus } from '$lib/shared/integrations';

/** Push updates to every open tab (relayed by /api/events as `event: live`); channel names `<module>:<name>`. */
export interface LivePublisher {
	send(channel: string, data: unknown): void;
}

/** An ordered list of hook functions. */
export interface HookList<F> {
	add(fn: F): () => void;
	readonly size: number;
	/** In registration order. */
	list(): F[];
}

export function hookList<F>(): HookList<F> {
	let fns: F[] = [];
	return {
		add(fn) {
			fns.push(fn);
			return () => (fns = fns.filter((f) => f !== fn));
		},
		get size() {
			return fns.length;
		},
		list: () => [...fns]
	};
}

export interface Hooks {
	/**
	 * Runs inside the PrintFiles send task, before the upload, for sends with `wake: true` (the queue
	 * does this; home-automation powers the plug and waits for the printer). A throwing hook aborts the
	 * send with its message. Callers never run these themselves.
	 */
	beforeDispatch: HookList<
		(ctx: { printerId: string; jobId: string; signal: AbortSignal }) => Promise<void>
	>;
}

export function createHooks(): Hooks {
	return { beforeDispatch: hookList() };
}

export interface ModuleContext {
	db: DB;
	lab: Lab;
	bus: EventBus;
	printers: PrinterManager;
	tasks: TaskCenter;
	printing: PrintFiles;
	models: ModelStore;
	hooks: Hooks;
	live: LivePublisher;
	env: Record<string, string | undefined>;
	/** A directory beside the database (per database name, like models/), for this module's files. */
	dataDir: string;
	/** Prefixes "[print-lab:<key>]". */
	log(message: string): void;
	/** This module's settings, stored as JSON in meta under settings:<key>. */
	settings<T>(schema: z.ZodType<T>, defaults: T): SettingsStore<T>;
	module<K extends keyof ModuleServices>(key: K): ModuleServices[K] | undefined;
}

export interface ServerModule<K extends string = string, S = unknown> {
	key: K;
	/** Start order (lower first); default 100. */
	order?: number;
	/** Returns the service others reach through ctx.module(key) / rt.module(key). */
	start(ctx: ModuleContext): S;
	stop?(): void | Promise<void>;
	/** Rows for the Integrations page (status + setup steps). */
	integrations?(): IntegrationStatus[] | Promise<IntegrationStatus[]>;
	/** Extra GET API paths kid mode may read (default: none). */
	kidReads?: RegExp[];
}

/** Services by module key; packages add their entry by declaration merging in modules/<key>/module.ts. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ModuleServices {}

export function defineModule<K extends string, S>(m: ServerModule<K, S>): ServerModule<K, S> {
	return m;
}

/** A module as the runtime tracks it. */
export interface LoadedModule {
	module: ServerModule;
	/** 'started', or why it is off. */
	state: 'started' | 'failed' | 'skipped';
	error?: string;
	service?: unknown;
}

/**
 * Starts modules in order; a failing one logs and stays off. `only` limits which keys start (tests:
 * `[]` starts none). Returns them with their state, in start order.
 */
export function startModules(
	modules: ServerModule[],
	make: (m: ServerModule) => ModuleContext,
	o: { only?: string[]; log: (m: string) => void; services: Map<string, unknown> }
): LoadedModule[] {
	const seen = new Set<string>();
	const sorted = [...modules].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
	return sorted.map((module) => {
		if (seen.has(module.key)) {
			o.log(`Module ${module.key} is defined twice; the second one stays off.`);
			return { module, state: 'skipped' as const, error: 'Defined twice.' };
		}
		seen.add(module.key);
		if (o.only && !o.only.includes(module.key)) return { module, state: 'skipped' as const };
		try {
			const service = module.start(make(module));
			o.services.set(module.key, service);
			return { module, state: 'started' as const, service };
		} catch (error) {
			o.log(`Module ${module.key} could not start: ${(error as Error).message}`);
			return { module, state: 'failed' as const, error: (error as Error).message };
		}
	});
}

/** Stops started modules in reverse order; errors are logged. */
export async function stopModules(loaded: LoadedModule[], log: (m: string) => void) {
	for (const m of [...loaded].reverse()) {
		if (m.state !== 'started') continue;
		try {
			await m.module.stop?.();
		} catch (error) {
			log(`Module ${m.module.key} did not stop cleanly: ${(error as Error).message}`);
		}
	}
}
