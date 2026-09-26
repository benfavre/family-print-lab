// Status and self-tests for everything the lab connects to: the AI providers, Blender, the OpenSCAD
// engine, the slicer, the printers, and whatever server modules add. Statuses run the CLIs, so they
// are cached briefly.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Runtime } from './runtime';
import { AI_TASKS, AI_TASK_LABEL, getSettings } from './settings';
import { blenderInfo, runJob } from './cad/blender';
import { OPENSCAD_VERSION, renderScad } from './cad/openscad';
import { writeStl } from './cad/mesh';
import { findSlicer, slice } from './slicer';
import { AppError } from './validation';
import {
	AI_PROVIDERS,
	AI_PROVIDER_NAME,
	AI_PROVIDER_VIA,
	type AiProviderId,
	type IntegrationId,
	type IntegrationStatus,
	type IntegrationTest,
	type IntegrationsReport
} from '$lib/shared/integrations';

const SETUP: Record<AiProviderId | 'blender', IntegrationStatus['setup']> = {
	'claude-code': [
		{ text: 'Install Claude Code', command: 'curl -fsSL https://claude.ai/install.sh | bash' },
		{ text: 'Sign in with your Claude subscription (type /login, then /exit)', command: 'claude' }
	],
	codex: [
		{ text: 'Install Codex', command: 'npm install -g @openai/codex' },
		{ text: 'Sign in with your ChatGPT account', command: 'codex login' }
	],
	'anthropic-api': [
		{
			text: 'Create a key at console.anthropic.com, add it to app/.env, then restart the app',
			command: 'ANTHROPIC_API_KEY=sk-ant-…'
		}
	],
	blender: [
		{
			text: 'Download a portable Blender (4.2 or newer) from blender.org and unpack it',
			command: 'mkdir -p ~/.local/opt && tar -xf blender-*-linux-x64.tar.xz -C ~/.local/opt'
		},
		{
			text: 'Or point the app at an existing install in app/.env',
			command: 'BLENDER_PATH=/path/to/blender'
		}
	]
};

let cache: { at: number; report: IntegrationsReport } | null = null;

export async function integrations(rt: Runtime, refresh = false): Promise<IntegrationsReport> {
	if (!refresh && cache && Date.now() - cache.at < 60_000) return withSettings(rt, cache.report);
	const settings = getSettings(rt.db);
	const [ai, blender] = await Promise.all([
		Promise.all(AI_PROVIDERS.map((id) => rt.providerById(id).status())),
		blenderInfo()
	]);
	const powers = (id: AiProviderId) =>
		AI_TASKS.filter((t) => settings.ai.routing[t] === id).map((t) => AI_TASK_LABEL[t]);
	const printers = rt.printers.statuses();
	const enabled = printers.filter((p) => p.enabled !== false);
	const connected = enabled.filter((p) => p.connected);
	const simulated = printers.length > 0 && printers.every((p) => p.simulated);
	const sliceModel = rt.printers.primary()?.model.short ?? 'X2D';
	const slicer = findSlicer();
	const moduleRows = (
		await Promise.all(
			rt
				.loadedModules()
				.filter((m) => m.state === 'started' && m.module.integrations)
				.map(async (m) => {
					try {
						return (await m.module.integrations!()).map((row) => ({
							...row,
							kind: 'module' as const
						}));
					} catch {
						return [];
					}
				})
		)
	).flat();
	const items: IntegrationStatus[] = [
		...ai.map((s) => ({
			id: s.id,
			kind: 'ai' as const,
			name: AI_PROVIDER_NAME[s.id],
			via: AI_PROVIDER_VIA[s.id],
			available: s.available,
			detail: s.detail,
			version: settings.ai.models[s.id] || null,
			powers: powers(s.id),
			setup: SETUP[s.id]
		})),
		{
			id: 'blender',
			kind: 'tool',
			name: 'Blender',
			via: 'Local install, run headless or in its own window',
			available: blender.available,
			detail: blender.available ? blender.path! : 'Not found on this computer.',
			version: blender.version,
			powers: ['Mesh repair', 'Simplify', 'Open in Blender (saves come back as versions)'],
			setup: SETUP.blender
		},
		{
			id: 'openscad',
			kind: 'tool',
			name: 'OpenSCAD',
			via: 'Built in, runs inside the app',
			available: true,
			detail: 'Each render runs in its own worker with a time limit.',
			version: OPENSCAD_VERSION,
			powers: ['Parametric models', 'Live preview', 'Checking AI designs', 'Text'],
			setup: []
		},
		{
			id: 'slicer',
			kind: 'tool',
			name: 'Bambu Studio',
			via: `Local install, sliced headless for your printer (${sliceModel})`,
			available: slicer.available,
			detail: slicer.available ? slicer.path! : 'Not found on this computer.',
			version: slicer.version,
			powers: [
				'Slices model versions with the job’s settings',
				'Real print time and filament',
				'Bambu Lab profiles for every printer and material'
			],
			setup: slicer.available
				? []
				: [
						{
							text: 'Download the Linux AppImage from github.com/bambulab/BambuStudio/releases and unpack it',
							command:
								'cd ~/.local/opt && chmod +x BambuStudio_*.AppImage && ./BambuStudio_*.AppImage --appimage-extract && mv squashfs-root bambu-studio-<version>'
						},
						{
							text: 'Or point the app at an unpacked install in app/.env',
							command: 'BAMBU_STUDIO_PATH=/path/to/AppRun'
						}
					]
		},
		{
			id: 'printer',
			kind: 'printer',
			name:
				printers.length === 1
					? (printers[0].name ?? 'Bambu Lab printer')
					: printers.length
						? `${printers.length} printers`
						: 'Bambu Lab printers',
			via: simulated
				? 'Simulator (until the real printer arrives)'
				: 'Local network (LAN-only mode + Developer Mode)',
			available: enabled.length > 0 && connected.length === enabled.length,
			detail: !printers.length
				? 'Not set up.'
				: enabled
						.map(
							(p) =>
								`${p.name}: ${p.connected ? `connected${p.state?.gcodeState ? ` · ${p.state.gcodeState.toLowerCase()}` : ''}` : p.error || 'waiting for the printer…'}`
						)
						.join(' · ') || 'Every printer is switched off.',
			version: null,
			powers: [
				'Live status',
				'Sends sliced plates and starts them',
				'Pause, resume, stop',
				'Closes jobs when prints finish'
			],
			setup: printers.length
				? []
				: [
						{ text: 'On the printer: Settings → Network → LAN Only, then turn on Developer Mode' },
						{ text: 'Then add it under Printers at the top of this page (or press Find printers)' }
					]
		},
		...moduleRows
	];
	cache = {
		at: Date.now(),
		report: {
			items,
			checkedAt: new Date().toISOString(),
			routing: settings.ai.routing,
			models: settings.ai.models,
			tasks: []
		}
	};
	return withSettings(rt, cache.report);
}

/** Routing and "powers" always reflect the latest Settings, even when statuses come from the cache. */
function withSettings(rt: Runtime, report: IntegrationsReport): IntegrationsReport {
	const settings = getSettings(rt.db);
	const tasksOf = (id: string) =>
		AI_TASKS.filter((t) => settings.ai.routing[t] === id).map((t) => AI_TASK_LABEL[t]);
	return {
		...report,
		items: report.items.map((i) =>
			i.kind === 'ai'
				? { ...i, powers: tasksOf(i.id), version: settings.ai.models[i.id as AiProviderId] || null }
				: i
		),
		routing: settings.ai.routing,
		models: settings.ai.models,
		tasks: AI_TASKS.map((id) => ({ id, label: AI_TASK_LABEL[id] }))
	};
}

export function forgetStatuses() {
	cache = null;
}

/** A small real round trip through one integration. AI tests use a few tokens of the subscription. */
export async function testIntegration(
	rt: Runtime,
	id: IntegrationId,
	signal?: AbortSignal
): Promise<IntegrationTest> {
	const started = performance.now();
	const ms = () => Math.round(performance.now() - started);
	try {
		if ((AI_PROVIDERS as readonly string[]).includes(id)) {
			const reply = await rt.providerById(id as AiProviderId).structured<{ reply: string }>({
				system:
					'You are a friendly assistant in a family 3D-printing lab. Answer in one short sentence.',
				prompt: 'Say hello to the family and name one fun thing to 3D print.',
				schema: {
					type: 'object',
					properties: { reply: { type: 'string' } },
					required: ['reply'],
					additionalProperties: false
				},
				effort: 'low',
				signal
			});
			return { ok: true, ms: ms(), detail: reply.reply };
		}
		if (id === 'openscad') {
			const r = await renderScad('$fn = 48; difference() { cube(20, center = true); sphere(13); }');
			return {
				ok: r.ok,
				ms: ms(),
				detail: r.ok
					? `Rendered a test part (${r.soup!.length / 9} triangles) in ${r.ms} ms.`
					: (r.diagnostics[0]?.message ?? 'Render failed.')
			};
		}
		if (id === 'blender') {
			const r = await renderScad('cube(20);');
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'print-lab-blender-test-'));
			try {
				fs.writeFileSync(path.join(dir, 'in.stl'), writeStl(r.soup!));
				const report = await runJob('repair', path.join(dir, 'in.stl'), path.join(dir, 'out.stl'));
				return {
					ok: true,
					ms: ms(),
					detail: `Repaired a test mesh headless (${report.faces_before ?? '?'} faces, ${report.non_manifold_edges ?? 0} open edges).`
				};
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		}
		if (id === 'slicer') {
			const r = await renderScad('cube([20, 20, 10]);');
			const out = await slice({
				stl: writeStl(r.soup!),
				name: 'Test cube',
				settings: {
					model: rt.printers.primary()?.model.code ?? 'N6',
					nozzle: '0.4',
					layerHeight: '0.20',
					material: 'PLA',
					supports: 'None',
					infill: 15,
					plate: 'Textured PEI'
				},
				signal
			});
			return {
				ok: true,
				ms: ms(),
				detail: `Sliced a test cube for the ${rt.printers.primary()?.model.short ?? 'X2D'}: ${out.minutes} min, ${out.grams} g (${out.choice.process}).`
			};
		}
		if (id === 'printer') {
			const all = rt.printers.statuses().filter((p) => p.enabled !== false);
			if (!all.length) return { ok: false, ms: ms(), detail: 'No printer is set up.' };
			const offline = all.filter((p) => !p.connected);
			return offline.length
				? {
						ok: false,
						ms: ms(),
						detail: offline.map((p) => `${p.name}: ${p.error || 'not connected yet'}`).join(' · ')
					}
				: {
						ok: true,
						ms: ms(),
						detail: `Receiving live reports from ${all.length === 1 ? all[0].name : `all ${all.length} printers`}.`
					};
		}
		// Rows from modules report their own state; there is nothing more to run.
		const row = (await integrations(rt)).items.find((i) => i.id === id && i.kind === 'module');
		if (row) return { ok: row.available, ms: ms(), detail: row.detail };
		throw new AppError(404, 'Unknown integration.');
	} catch (error) {
		if (error instanceof AppError && error.status === 404) throw error;
		return { ok: false, ms: ms(), detail: (error as Error).message };
	} finally {
		forgetStatuses();
	}
}
