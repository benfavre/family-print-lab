// Print Lab Slicer: opens our engine (or the stock Bambu Studio command line when the engine is not
// installed) for the rest of the app, stops it on shutdown, uses slicer-profiles' presets when that
// package is installed, and reports which backend slices on the Integrations page.
import { defineModule, type ModuleContext } from '../../modules';
import type { ProfileServiceModule, SlicerServiceModule } from '../contracts';
import { closeSlicer, openSlicer, type SlicerEngine } from '../../slicer/engine';
import { locateCli, locateEngine } from '../../slicer/locate';
import { configureSlicer } from '../../slicer/service';
import type { IntegrationStatus } from '$lib/shared/integrations';

declare module '../../modules' {
	interface ModuleServices {
		'slicer-engine': SlicerServiceModule;
	}
}

const POWERS = [
	'Slices model versions with the job’s settings',
	'Real print time and filament',
	'Bambu Lab profiles for every printer and material'
];

/** The Integrations row: which backend slices, its versions, and how to get one when there is none. */
export function slicerRow(
	engine: SlicerEngine | null,
	o: { printer: string; enginePath: string | null; cliPath: string | null; engineFailed: boolean }
): IntegrationStatus {
	const base = { id: 'slicer', kind: 'module' as const, name: 'Print Lab Slicer', powers: POWERS };
	if (engine?.info.engine === 'printlab-slicer') {
		const { info } = engine;
		const queue = info.patchQueue;
		return {
			...base,
			via: `Built in, from Bambu Studio ${info.upstream.tag} (sliced for your ${o.printer})`,
			available: true,
			detail: [
				o.enginePath,
				`Bambu Studio ${info.upstream.tag}${info.upstream.commit ? ` (${info.upstream.commit.slice(0, 10)})` : ''}`,
				queue ? `patch queue ${queue.version}, ${queue.patches.length} patch(es)` : null,
				info.profiles ? `profiles ${info.profiles.vendorVersion}` : null
			]
				.filter(Boolean)
				.join(' · '),
			version: info.version,
			setup: []
		};
	}
	if (engine) {
		const orca = engine.info.engine === 'orca-slicer-cli';
		return {
			...base,
			via: `${orca ? 'OrcaSlicer' : 'Bambu Studio'} command line (fallback), sliced headless for your ${o.printer}`,
			available: true,
			detail: `${o.cliPath ?? ''} · ${
				o.engineFailed
					? 'Print Lab Slicer was found but did not start, so the command line slices.'
					: 'Print Lab Slicer is not installed, so the command line slices (no modifiers or painting).'
			}`,
			version: engine.info.version === 'unknown' ? null : engine.info.version,
			setup: []
		};
	}
	return {
		...base,
		via: 'Not installed',
		available: false,
		detail: o.engineFailed
			? `Print Lab Slicer at ${o.enginePath} did not start, and Bambu Studio is not installed.`
			: 'Not found on this computer. The desktop app includes it.',
		version: null,
		setup: [
			{
				text: 'Download the Bambu Studio Linux AppImage from github.com/bambulab/BambuStudio/releases and unpack it',
				command:
					'cd ~/.local/opt && chmod +x BambuStudio_*.AppImage && ./BambuStudio_*.AppImage --appimage-extract && mv squashfs-root bambu-studio-<version>'
			},
			{
				text: 'Or point the app at an unpacked install in app/.env',
				command: 'BAMBU_STUDIO_PATH=/path/to/AppRun'
			},
			{
				text: 'Or build Print Lab Slicer from this repository (hours the first time)',
				command: 'slicer/scripts/upstream.sh fetch && slicer/scripts/upstream.sh build'
			}
		]
	};
}

let context: ModuleContext | null = null;

export default defineModule({
	key: 'slicer-engine',
	order: 60,
	start(ctx) {
		context = ctx;
		// slicer-profiles' presets (user presets, compatibility rules) when that package is installed.
		const module = ctx.module as (key: string) => unknown;
		configureSlicer({
			env: ctx.env,
			profiles: () => (module('slicer-profiles') as ProfileServiceModule | undefined)?.profiles
		});
		return { open: () => openSlicer(ctx.env) };
	},
	async stop() {
		configureSlicer({});
		context = null;
		await closeSlicer();
	},
	async integrations() {
		const env = context?.env ?? process.env;
		const engine = await openSlicer(env);
		const found = locateEngine(env);
		return [
			slicerRow(engine, {
				printer: context?.printers.primary()?.model.short ?? 'printer',
				enginePath: found?.path ?? null,
				cliPath: locateCli(env)?.path ?? null,
				engineFailed: !!found && engine?.info.engine !== 'printlab-slicer'
			})
		];
	}
});
