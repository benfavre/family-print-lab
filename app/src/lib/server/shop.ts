// The shop inside the app: buying goes through the linked Print Lab Cloud account (credits), and
// installing turns what was bought into something here. Kid mode packs install themselves (see
// kid/packs.ts); a part becomes a project with a parametric model to adjust in the workbench; a
// ready-made model becomes a project with the imported file. What was installed is remembered.
import { eq } from 'drizzle-orm';
import type { DB } from './db';
import { meta } from './db/schema';
import type { Runtime } from './runtime';
import { AppError } from './validation';

const KEY = 'shop_installed';

export interface Installed {
	version: number;
	projectId: string | null;
	at: string;
}

export function installed(db: DB): Record<string, Installed> {
	const row = db.select().from(meta).where(eq(meta.key, KEY)).get();
	return row ? (JSON.parse(row.value) as Record<string, Installed>) : {};
}

function remember(db: DB, id: string, entry: Installed) {
	const value = JSON.stringify({ ...installed(db), [id]: entry });
	db.insert(meta)
		.values({ key: KEY, value })
		.onConflictDoUpdate({ target: meta.key, set: { value } })
		.run();
}

const CATEGORY: Record<string, 'Home' | 'Office' | 'Creative'> = {
	'storage-box': 'Home',
	'drawer-grid': 'Home',
	'cable-clip': 'Office',
	'wall-hook': 'Home',
	'headphone-stand': 'Office',
	'phone-stand': 'Office',
	'plant-pot': 'Home'
};

export async function install(rt: Runtime, itemId: string, profileId: string) {
	const cloud = rt.cloud;
	if (!cloud) throw new AppError(404, 'Print Lab Cloud is not set up here (CLOUD_URL).');
	const item = (await cloud.library()).find((i) => i.id === itemId);
	if (!item) throw new AppError(404, 'This is not in your library. Buy it first.');
	if (item.kind === 'kid-pack') {
		await cloud.syncPacks();
		remember(rt.db, item.id, {
			version: item.version,
			projectId: null,
			at: new Date().toISOString()
		});
		return { kind: item.kind, projectId: null };
	}
	const projectId = rt.lab.createProject({
		profileId,
		title: item.title,
		category: CATEGORY[item.id] ?? 'Home',
		description: `${item.blurb} From the Print Lab shop.`,
		checklist: []
	});
	try {
		if (item.kind === 'part') {
			if (!item.source || !item.name) throw new AppError(502, 'This part came without its design.');
			await rt.models.createParametric(
				projectId,
				item.name,
				item.source,
				`shop:${item.id}`,
				'From the shop'
			);
		} else {
			if (!item.file || !item.format) throw new AppError(502, 'This model came without its file.');
			rt.models.importFile(projectId, item.title, await cloud.libraryFile(item.file), item.format);
		}
	} catch (error) {
		rt.lab.deleteProject(projectId);
		throw error;
	}
	remember(rt.db, item.id, { version: item.version, projectId, at: new Date().toISOString() });
	rt.lab.touch('project', `Installed “${item.title}” from the shop`);
	return { kind: item.kind, projectId };
}
