// AI print checks: catch spaghetti, a part that came loose or a blob early from camera pictures.
// Off by default. When a parent switches it on, each print is checked every N layers and/or M minutes
// by the rough check on this computer (ffmpeg, nothing leaves the house) or by the AI provider they
// picked (Claude Code, Codex or the Anthropic API; the picture and the print's name go to it). A sure
// enough problem raises `vision.alert` (the notifications package tells people) and, only if asked,
// pauses the print. Routes: /api/printers/[id]/vision/**, /api/vision/settings. Live channel
// "ai-vision:check".
import { defineModule, type ModuleContext } from '$lib/server/modules';
import type { CameraService } from '$lib/server/modules/contracts';
import type { SettingsStore } from '$lib/server/module-settings';
import type { PrintRef } from '$lib/server/events';
import {
	anthropicApi,
	claudeCode,
	codex,
	PROVIDER_LABEL,
	type Provider,
	type ProviderId
} from '$lib/server/ai/providers';
import { getSettings } from '$lib/server/settings';
import { AppError, parse } from '$lib/server/validation';
import { AI_PROVIDERS } from '$lib/shared/integrations';
import {
	methodLabel,
	VISION_SETTINGS_DEFAULTS,
	type VisionCheck,
	type VisionMethod,
	type VisionOverview,
	type VisionSettings,
	type VisionSettingsView,
	type VisionVerdict
} from '$lib/shared/vision';
import { findFfmpeg } from './heuristic';
import { activeFor } from './schedule';
import { VisionChecker } from './service';
import { VisionStore } from './store';
import {
	listQuery,
	printerToggleInput,
	visionSettingsInput,
	visionSettingsSchema
} from './validation';

export interface VisionService {
	settings: SettingsStore<VisionSettings>;
	store: VisionStore;
	checker: VisionChecker;
	view(): VisionSettingsView;
	saveSettings(input: unknown): VisionSettingsView;
	overview(printerId: string): VisionOverview;
	setPrinter(printerId: string, input: unknown): VisionOverview;
	list(printerId: string, query: Record<string, string>): VisionCheck[];
	checkNow(printerId: string, signal?: AbortSignal): Promise<VisionCheck>;
	frame(printerId: string, checkId: string): Buffer;
	/** Resolves when no check is running (tests). */
	idle(): Promise<void>;
}

declare module '$lib/server/modules' {
	interface ModuleServices {
		'ai-vision': VisionService;
	}
}

declare module '$lib/server/events' {
	interface LabEventMap {
		'vision.alert': PrintRef & {
			checkId: string;
			verdict: VisionVerdict;
			confidence: number;
			layer: number | null;
			/** The print was paused because of it. */
			paused: boolean;
			provider: VisionMethod;
			/** What the check saw, in its own words. */
			detail: string;
			/** A plain sentence for notifications: verdict, how sure, what it saw, paused or not. */
			reason: string;
		};
	}
}

const DAY = 86_400_000;

export interface VisionModuleOptions {
	/** The AI provider for an id (tests pass a stand-in). */
	provider?: (ctx: ModuleContext, id: ProviderId) => Provider;
	/** ffmpeg's path (tests: null to act as if it were missing). */
	ffmpeg?: () => string | null;
}

/** The provider for an id, with the model chosen in Settings, as the runtime builds it. */
function realProvider(ctx: ModuleContext, id: ProviderId): Provider {
	const model = getSettings(ctx.db).ai.models[id] || undefined;
	if (id === 'claude-code') return claudeCode({ bin: ctx.env.CLAUDE_BIN, model });
	if (id === 'codex') return codex({ bin: ctx.env.CODEX_BIN, model });
	return anthropicApi({ env: ctx.env, model });
}

export function visionModule(o: VisionModuleOptions = {}) {
	let current: VisionService | null = null;
	let stopping: (() => void) | null = null;
	return defineModule({
		key: 'ai-vision',
		order: 140,
		start(ctx): VisionService {
			const settings = ctx.settings(visionSettingsSchema, VISION_SETTINGS_DEFAULTS);
			const store = new VisionStore(ctx.db, ctx.dataDir);
			let found: { path: string | null; at: number } | null = null;
			const ffmpeg =
				o.ffmpeg ??
				(() => {
					if (!found || Date.now() - found.at > 30_000)
						found = { path: findFfmpeg(ctx.env), at: Date.now() };
					return found.path;
				});
			const camera = () =>
				(ctx.module as (key: string) => unknown)('camera') as CameraService | undefined;
			const checker = new VisionChecker({
				store,
				settings,
				printers: ctx.printers,
				bus: ctx.bus,
				live: ctx.live,
				camera,
				provider: (id) => (o.provider ?? realProvider)(ctx, id),
				ffmpeg,
				log: ctx.log
			});
			checker.start();

			const prune = () => {
				try {
					store.prune();
				} catch (error) {
					ctx.log(`Could not remove old pictures: ${(error as Error).message}`);
				}
			};
			prune();
			const daily = setInterval(prune, DAY);
			daily.unref?.();
			stopping = () => {
				clearInterval(daily);
				checker.stop();
			};

			const printer = (id: string) => {
				const p = ctx.printers.get(id);
				if (!p) throw new AppError(404, 'That printer is not here any more.');
				return p;
			};
			const view = (): VisionSettingsView => ({
				settings: settings.get(),
				methods: [
					{ id: 'local', label: methodLabel('local', PROVIDER_LABEL) },
					...AI_PROVIDERS.map((id) => ({ id, label: PROVIDER_LABEL[id] }))
				],
				ffmpeg: !!ffmpeg(),
				camera: !!camera()
			});
			const overview = (id: string): VisionOverview => {
				printer(id);
				const s = settings.get();
				return {
					printerId: id,
					active: activeFor(s, id),
					printerOn: s.printers[id] !== false,
					settings: s,
					methodLabel: methodLabel(s.method, PROVIDER_LABEL),
					running: checker.isRunning(id),
					camera: !!camera()?.has(id),
					recent: store.list(id, { limit: 8 })
				};
			};

			const service: VisionService = {
				settings,
				store,
				checker,
				view,
				saveSettings(input) {
					const patch = parse(visionSettingsInput, input);
					settings.set({ ...settings.get(), ...patch });
					return view();
				},
				overview,
				setPrinter(id, input) {
					printer(id);
					const { enabled } = parse(printerToggleInput, input);
					const s = settings.get();
					const printers = { ...s.printers };
					if (enabled) delete printers[id];
					else printers[id] = false;
					settings.set({ ...s, printers });
					return overview(id);
				},
				list(id, query) {
					printer(id);
					return store.list(id, parse(listQuery, query));
				},
				checkNow: (id, signal) => checker.checkNow(id, signal),
				frame(id, checkId) {
					const jpeg = store.frame(id, checkId);
					if (!jpeg) throw new AppError(404, 'That picture is not kept any more.');
					return jpeg;
				},
				idle: () => checker.idle()
			};
			current = service;
			return service;
		},
		stop() {
			stopping?.();
			stopping = null;
			current = null;
		},
		integrations() {
			const s = current?.settings.get();
			const on = !!s?.enabled;
			const local = !s || s.method === 'local';
			return [
				{
					id: 'ai-vision',
					kind: 'module',
					name: 'AI print checks',
					via: s ? methodLabel(s.method, PROVIDER_LABEL) : 'Rough check on this computer',
					available: on,
					detail: on
						? local
							? 'Checks prints with the rough check on this computer. Pictures stay here.'
							: 'Checks prints with the AI you picked. It gets a camera picture and the print’s name.'
						: 'Off. A parent can switch it on to catch spaghetti and loose parts early.',
					powers: ['Spaghetti and loose part alerts', 'Pause a print that went wrong'],
					setup: [{ text: 'Integrations → AI print checks: switch on automatic checks.' }]
				}
			];
		}
	});
}

export default visionModule();
