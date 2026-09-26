import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { env } from '$env/dynamic/private';
import { openDatabase, type DB } from './db';
import { Lab } from './lab';
import { Backups } from './backup';
import { PrintFiles } from './printing';
import type { BambuPrinter } from './printer/bambu';
import { PrinterManager } from './printer/manager';
import { EventBus } from './events';
import {
	createHooks,
	startModules,
	stopModules,
	type Hooks,
	type LivePublisher,
	type LoadedModule,
	type ModuleContext,
	type ModuleServices,
	type ServerModule
} from './modules';
import { moduleSettings } from './module-settings';
import { createAi, type Assistant } from './ai/assistant';
import {
	anthropicApi,
	claudeCode,
	codex,
	findBin,
	PROVIDER_LABEL,
	type Provider,
	type ProviderId
} from './ai/providers';
import { getSettings, type AiTask } from './settings';
import { ModelStore } from './models';
import { TaskCenter } from './tasks';
import { SketchStore } from './sketches';
import { parseImport, replaceWorkspace } from './portability';
import { ParentPin } from './kid/pin';
import { CloudLink, type PrinterSource } from './cloud/link';
import { loadPacks } from './kid/packs';
import { version as appVersion } from '../../../package.json';
import type { PrinterStatus } from '$lib/shared/domain';

export interface Runtime {
	db: DB;
	lab: Lab;
	/** Typed lab events: printers, prints, alerts, trays, kids' requests (events.ts). */
	bus: EventBus;
	/** All saved printers and their connections. */
	printers: PrinterManager;
	models: ModelStore;
	tasks: TaskCenter;
	sketches: SketchStore;
	backups: Backups;
	/** @deprecated The first printer in Settings (single-printer callers); use `printers`. */
	readonly printer: BambuPrinter | null;
	/** Sliced files on jobs, and sending them to printers. */
	printing: PrintFiles;
	/** Extension points for modules (beforeDispatch…). */
	hooks: Hooks;
	/** Push updates to open tabs (relayed by /api/events as `live`). */
	live: LivePublisher & EventEmitter;
	ai: Assistant;
	/** The parent PIN that guards leaving kid mode. */
	pin: ParentPin;
	/** The optional Print Lab Cloud link (null unless CLOUD_URL is set). */
	cloud: CloudLink | null;
	/** A started module's service, if that module is present. */
	module<K extends keyof ModuleServices>(key: K): ModuleServices[K] | undefined;
	/** Every module found, with whether it started. */
	modules(): { key: string; state: LoadedModule['state']; error?: string }[];
	/** Loaded modules (integrations rows, kid reads). */
	loadedModules(): LoadedModule[];
	/** The provider configured for a task in Settings (resolved per request, so changes apply immediately). */
	provider(task: AiTask): Provider;
	providerById(id: ProviderId): Provider;
	/** Cheap check (no request) of whether the chat provider is installed/configured, for the UI. */
	aiSummary(): { configured: boolean; provider: ProviderId; label: string };
	/** @deprecated The first printer's status, or { configured: false }; use printers.statuses(). */
	printerStatus(): PrinterStatus;
	/** Stops everything (modules first, awaited). */
	close(): Promise<void>;
	shutdown(): void;
}

// Every modules/<key>/module.ts; folders starting with "__" hold test fixtures and are left out.
const MODULE_FILES = import.meta.glob<{ default: ServerModule }>(
	['./modules/*/module.ts', '!./modules/__*/module.ts'],
	{ eager: true }
);

export interface BootOptions {
	env: Record<string, string | undefined>;
	/** Module keys to start (default: all found; [] = none). */
	modules?: string[];
	/** Modules beyond the ones found in modules/ (tests). */
	extraModules?: ServerModule[];
	/** CA certificates for printer TLS instead of the bundled ones (tests). */
	printerCa?: (string | Buffer)[];
	log?: (message: string) => void;
}

export function bootRuntime(o: BootOptions): Runtime {
	const env = o.env;
	const log = o.log ?? ((message: string) => console.log(`[print-lab] ${message}`));
	const file = env.DATABASE_URL || 'data/printlab.db';
	const memory = file === ':memory:';
	const db = openDatabase(file);
	const bus = new EventBus((m) => log(m));
	const lab = new Lab(db, bus);
	const dataDir = path.dirname(path.resolve(memory ? 'data/x' : file));
	// Each database gets its own model folder by default (data/models for printlab.db, data/<name>-models otherwise),
	// because the store deletes folders it has no rows for.
	const dbName = path.basename(file, path.extname(file));
	const scratch = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `print-lab-${name}-`));
	const modelsDir = memory
		? scratch('models')
		: path.join(dataDir, dbName === 'printlab' ? 'models' : `${dbName}-models`);
	// Kept beside the database (dev and test databases get their own file).
	const tasks = new TaskCenter(
		memory
			? null
			: path.join(dataDir, dbName === 'printlab' ? 'tasks.json' : `${dbName}-tasks.json`)
	);
	const models = new ModelStore(db, lab, env.MODELS_DIR || modelsDir, tasks);

	// First run: bring over the previous app's data if it is present.
	const legacy = env.LEGACY_IMPORT || 'data/legacy/family.json';
	if (lab.snapshot().profiles.length === 0 && fs.existsSync(legacy)) {
		replaceWorkspace(db, lab, parseImport(JSON.parse(fs.readFileSync(legacy, 'utf8'))));
		log(`Imported the previous workspace from ${legacy}`);
	}

	models.sweep();

	const backups = new Backups(
		db,
		env.BACKUP_DIR || path.join(dataDir, 'backups'),
		models.dir,
		14,
		env.BACKUP_MIRROR || null
	);
	if (!memory) backups.schedule(log);

	// The lab's own listeners come first, so modules see jobs already linked and closed (events.ts).
	const printers = new PrinterManager(db, lab, bus, { env, log, ca: o.printerCa });
	const guard = (what: string, fn: () => void) => {
		try {
			fn();
		} catch (error) {
			log(`${what}: ${(error as Error).message}`);
		}
	};
	bus.on('print.started', (e) =>
		guard('Printer link skipped', () => lab.linkStartedTask(e.printerId, e.task))
	);
	bus.on('print.finished', (e) =>
		guard('Could not close the linked print job', () =>
			lab.closePrinterTask(e.printerId, e.task, 'succeeded')
		)
	);
	bus.on('print.failed', (e) =>
		guard('Could not close the linked print job', () =>
			lab.closePrinterTask(e.printerId, e.task, 'failed')
		)
	);
	bus.on('print.cancelled', (e) =>
		guard('Could not close the linked print job', () =>
			lab.closePrinterTask(e.printerId, e.task, 'cancelled')
		)
	);
	printers.start();

	const hooks = createHooks();
	const printing = new PrintFiles(
		lab,
		env.SLICED_DIR ||
			(memory
				? scratch('sliced')
				: path.join(dataDir, dbName === 'printlab' ? 'sliced' : `${dbName}-sliced`)),
		tasks,
		printers,
		models,
		hooks
	);
	printing.sweep();

	const live = Object.assign(new EventEmitter(), {
		send(channel: string, data: unknown) {
			live.emit('live', { channel: String(channel).slice(0, 80), data });
		}
	});
	live.setMaxListeners(200);

	const providerById = (id: ProviderId): Provider => {
		const model = getSettings(db).ai.models[id] || undefined;
		if (id === 'claude-code') return claudeCode({ bin: env.CLAUDE_BIN, model });
		if (id === 'codex') return codex({ bin: env.CODEX_BIN, model });
		return anthropicApi({ env, model });
	};
	const provider = (task: AiTask) => providerById(getSettings(db).ai.routing[task]);
	const ai = createAi(provider);
	log(`Database ${file} · AI via ${getSettings(db).ai.routing.chat}`);

	loadPacks(db);
	// Print Lab Cloud (protocol v1) knows one printer: the first one in Settings.
	const primarySource: PrinterSource = {
		status: () => printers.primary()?.status() ?? { configured: false },
		on: (_event, listener) => printers.on('update', listener),
		off: (_event, listener) => printers.off('update', listener)
	};
	// Print Lab Cloud is optional and does nothing until someone links this computer.
	const cloud = env.CLOUD_URL
		? new CloudLink(db, lab, models, env.CLOUD_URL, appVersion, undefined, primarySource)
		: null;
	cloud?.start();
	// With cloud backup on, the newest snapshot goes to the cloud, encrypted, about once a day.
	const cloudBackup = setInterval(() => void sendCloudBackup(), 6 * 3600_000);
	cloudBackup.unref();
	setTimeout(() => void sendCloudBackup(), 60_000).unref();
	async function sendCloudBackup() {
		const last = cloud?.status().backup.last;
		const dir = backups.newestDir();
		if (!cloud?.backupEnabled() || !dir) return;
		if (last && Date.now() - Date.parse(last.at) < 23 * 3600_000) return;
		try {
			const { size } = await cloud.uploadBackup(dir);
			log(`Cloud backup sent (${Math.round(size / 1e5) / 10} MB)`);
		} catch (error) {
			log(`Cloud backup failed: ${(error as Error).message}`);
		}
	}

	// Modules last: they get everything above.
	const services = new Map<string, unknown>();
	const found = [
		...Object.values(MODULE_FILES).map((m) => m.default),
		...(o.extraModules ?? [])
	].filter(
		(m): m is ServerModule => !!m && typeof m.key === 'string' && typeof m.start === 'function'
	);
	const context = (m: ServerModule): ModuleContext => {
		const dir = path.join(
			memory ? scratch('module') : dataDir,
			dbName === 'printlab' ? m.key : `${dbName}-${m.key}`
		);
		return {
			db,
			lab,
			bus,
			printers,
			tasks,
			printing,
			models,
			hooks,
			live,
			env,
			dataDir: dir,
			log: (message) => console.log(`[print-lab:${m.key}] ${message}`),
			settings: (schema, defaults) => moduleSettings(db, m.key, schema, defaults),
			module: (key) => services.get(key as string) as never
		};
	};
	const loaded = startModules(found, context, { only: o.modules, log, services });

	let closed: Promise<void> | null = null;
	const rt: Runtime = {
		db,
		lab,
		bus,
		printers,
		models,
		tasks,
		sketches: new SketchStore(db, lab),
		backups,
		get printer() {
			return printers.primary();
		},
		printing,
		hooks,
		live,
		ai,
		pin: new ParentPin(db),
		cloud,
		module: (key) => services.get(key as string) as never,
		modules: () => loaded.map((m) => ({ key: m.module.key, state: m.state, error: m.error })),
		loadedModules: () => loaded,
		provider,
		providerById,
		aiSummary() {
			const id = getSettings(db).ai.routing.chat;
			const configured =
				env.LAB_AI === 'off'
					? false
					: id === 'claude-code'
						? !!findBin('claude', env.CLAUDE_BIN)
						: id === 'codex'
							? !!findBin('codex', env.CODEX_BIN)
							: !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
			return { configured, provider: id, label: PROVIDER_LABEL[id] };
		},
		printerStatus: () => printers.primary()?.status() ?? { configured: false },
		close() {
			return (closed ??= (async () => {
				await stopModules(loaded, log);
				cloud?.stop();
				tasks.flush();
				printers.stop();
				clearInterval(cloudBackup);
				backups.stop();
				db.$client.close();
			})());
		},
		shutdown() {
			void rt.close();
		}
	};
	return rt;
}

// One runtime per process; kept on globalThis so dev-mode module reloads reuse the open database and printer links.
const key = Symbol.for('family-print-lab.runtime');
type Holder = typeof globalThis & { [key]?: Runtime };

export function runtime(): Runtime {
	const holder = globalThis as Holder;
	if (!holder[key]) {
		holder[key] = bootRuntime({ env });
		const stop = () => {
			void holder[key]
				?.close()
				.catch(() => {})
				.finally(() => process.exit(0));
		};
		process.once('SIGINT', stop);
		process.once('SIGTERM', stop);
	}
	return holder[key]!;
}
