import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env } from '$env/dynamic/private';
import { openDatabase, type DB } from './db';
import { Lab } from './lab';
import { Backups } from './backup';
import { PrintFiles } from './printing';
import { printerFromEnv, type BambuPrinter } from './printer/bambu';
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
import { CloudLink } from './cloud/link';
import { version as appVersion } from '../../../package.json';
import type { PrinterStatus } from '$lib/shared/domain';

export interface Runtime {
	db: DB;
	lab: Lab;
	models: ModelStore;
	tasks: TaskCenter;
	sketches: SketchStore;
	backups: Backups;
	printer: BambuPrinter | null;
	/** Sliced files on jobs, and sending them to the printer. */
	printing: PrintFiles;
	ai: Assistant;
	/** The parent PIN that guards leaving kid mode. */
	pin: ParentPin;
	/** The optional Print Lab Cloud link (null unless CLOUD_URL is set). */
	cloud: CloudLink | null;
	/** The provider configured for a task in Settings (resolved per request, so changes apply immediately). */
	provider(task: AiTask): Provider;
	providerById(id: ProviderId): Provider;
	/** Cheap check (no request) of whether the chat provider is installed/configured, for the UI. */
	aiSummary(): { configured: boolean; provider: ProviderId; label: string };
	printerStatus(): PrinterStatus;
	shutdown(): void;
}

const log = (message: string) => console.log(`[print-lab] ${message}`);

function boot(): Runtime {
	const file = env.DATABASE_URL || 'data/printlab.db';
	const db = openDatabase(file);
	const lab = new Lab(db);
	const dataDir = path.dirname(path.resolve(file === ':memory:' ? 'data/x' : file));
	// Each database gets its own model folder by default (data/models for printlab.db, data/<name>-models otherwise),
	// because the store deletes folders it has no rows for.
	const dbName = path.basename(file, path.extname(file));
	const modelsDir =
		file === ':memory:'
			? fs.mkdtempSync(path.join(os.tmpdir(), 'print-lab-models-'))
			: path.join(dataDir, dbName === 'printlab' ? 'models' : `${dbName}-models`);
	// Kept beside the database (dev and test databases get their own file).
	const tasks = new TaskCenter(
		file === ':memory:'
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
	if (file !== ':memory:') backups.schedule(log);

	const printer = printerFromEnv(env);
	if (printer) {
		printer.on('started', ({ task }) => {
			try {
				lab.linkStartedTask(task);
			} catch (error) {
				log(`Printer link skipped: ${(error as Error).message}`);
			}
		});
		printer.on('finished', ({ task, ok }) => {
			try {
				lab.closePrinterTask(task, ok);
			} catch (error) {
				log(`Could not close the linked print job: ${(error as Error).message}`);
			}
		});
		printer.start();
	}

	const printing = new PrintFiles(
		lab,
		env.SLICED_DIR ||
			(file === ':memory:'
				? fs.mkdtempSync(path.join(os.tmpdir(), 'print-lab-sliced-'))
				: path.join(dataDir, dbName === 'printlab' ? 'sliced' : `${dbName}-sliced`)),
		tasks,
		printer,
		models
	);
	printing.sweep();

	const providerById = (id: ProviderId): Provider => {
		const model = getSettings(db).ai.models[id] || undefined;
		if (id === 'claude-code') return claudeCode({ bin: env.CLAUDE_BIN, model });
		if (id === 'codex') return codex({ bin: env.CODEX_BIN, model });
		return anthropicApi({ env, model });
	};
	const provider = (task: AiTask) => providerById(getSettings(db).ai.routing[task]);
	const ai = createAi(provider);
	log(
		`Database ${file} · printer ${printer ? `${printer.name}${printer.config.simulated ? ' (SIMULATOR)' : ''} at ${printer.config.host}:${printer.config.port}` : 'not configured'} · AI via ${getSettings(db).ai.routing.chat}`
	);

	// Print Lab Cloud is optional and does nothing until someone links this computer.
	const cloud = env.CLOUD_URL ? new CloudLink(db, lab, models, env.CLOUD_URL, appVersion) : null;
	cloud?.start();

	return {
		db,
		lab,
		models,
		tasks,
		sketches: new SketchStore(db, lab),
		backups,
		printer,
		printing,
		ai,
		pin: new ParentPin(db),
		cloud,
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
		printerStatus: () => printer?.status() ?? { configured: false },
		shutdown() {
			cloud?.stop();
			tasks.flush();
			printer?.stop();
			backups.stop();
			db.$client.close();
		}
	};
}

// One runtime per process; kept on globalThis so dev-mode module reloads reuse the open database and printer link.
const key = Symbol.for('family-print-lab.runtime');
type Holder = typeof globalThis & { [key]?: Runtime };

export function runtime(): Runtime {
	const holder = globalThis as Holder;
	if (!holder[key]) {
		holder[key] = boot();
		const stop = () => {
			holder[key]?.shutdown();
			process.exit(0);
		};
		process.once('SIGINT', stop);
		process.once('SIGTERM', stop);
	}
	return holder[key]!;
}
