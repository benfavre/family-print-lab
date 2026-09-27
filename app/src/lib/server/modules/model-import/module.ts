// model-import: paste a Printables, Thingiverse or MakerWorld link to get a project with credits,
// licence, pictures and (where the site allows) the files. Nothing is fetched until someone asks; the
// Thingiverse app token is the user's own, saved on this computer and never sent to the browser.
import { defineModule } from '$lib/server/modules';
import { parse } from '$lib/server/validation';
import { createFetcher } from './fetch';
import { findFfmpeg } from '$lib/server/ffmpeg';
import { ImportService } from './service';
import { settingsInput, storedSettings } from './validation';
import type { ImportSettingsView } from '$lib/shared/model-import';

export interface ModelImportService {
	imports: ImportService;
	settings(): ImportSettingsView;
	saveSettings(input: unknown): ImportSettingsView;
}

declare module '$lib/server/modules' {
	interface ModuleServices {
		'model-import': ModelImportService;
	}
}

let hasToken = () => false;

export default defineModule({
	key: 'model-import',
	start(ctx): ModelImportService {
		const store = ctx.settings(storedSettings, { thingiverseToken: '' });
		hasToken = () => !!store.get().thingiverseToken;
		const imports = new ImportService({
			db: ctx.db,
			lab: ctx.lab,
			models: ctx.models,
			tasks: ctx.tasks,
			fetch: createFetcher(),
			thingiverseToken: () => store.get().thingiverseToken,
			ffmpeg: () => findFfmpeg(ctx.env),
			log: ctx.log
		});
		const view = (): ImportSettingsView => ({ hasThingiverseToken: hasToken() });
		return {
			imports,
			settings: view,
			saveSettings(input) {
				const { thingiverseToken } = parse(settingsInput, input);
				if (thingiverseToken !== undefined) store.set({ thingiverseToken });
				return view();
			}
		};
	},
	integrations: () => [
		{
			id: 'model-import',
			kind: 'module',
			name: 'Model links',
			via: 'Printables, Thingiverse and MakerWorld',
			available: true,
			detail: hasToken()
				? 'Paste a model link to bring in credits, licence, pictures and files. Thingiverse token saved.'
				: 'Paste a model link to bring in credits, licence, pictures and files. Thingiverse needs your own app token for details and downloads.',
			powers: ['Projects from model links, with credits', 'Drag and drop STL, 3MF and OBJ files'],
			setup: []
		}
	]
});
