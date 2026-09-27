// Importing from a model page link: preview (details, licence, pictures, files), then confirm (a new or
// existing project gets the credit in its description and a project_sources row, the chosen files
// become models through ModelStore, pictures become sketches). Previews are kept for 10 minutes so a
// confirm does not ask the site again.
import { and, eq } from 'drizzle-orm';
import type { DB } from '$lib/server/db';
import { projects, projectSources } from '$lib/server/db/schema';
import type { Lab } from '$lib/server/lab';
import type { ModelStore } from '$lib/server/models';
import { SketchStore } from '$lib/server/sketches';
import { AppError, parse } from '$lib/server/validation';
import {
	creditText,
	parseModelLink,
	SITE_NAME,
	withCredit,
	type ImportPreview,
	type ImportResult,
	type ImportSite,
	type ModelLink
} from '$lib/shared/model-import';
import { HOSTS, type Fetcher } from './fetch';
import { toPng } from './pictures';
import { makerworld } from './sites/makerworld';
import { printables } from './sites/printables';
import { thingiverse } from './sites/thingiverse';
import type { LoadedModel, Site } from './sites/types';
import { confirmInput, previewInput } from './validation';

const SITES: Record<ImportSite, Site> = { printables, thingiverse, makerworld };
const CACHE_MS = 10 * 60_000;
const MAX_PICTURES = 6;
/** Every host a picture may come from (the image proxy refuses the rest). */
const IMAGE_HOSTS = [
	...HOSTS.printablesMedia,
	...HOSTS.thingiverseCdn,
	...HOSTS.makerworldMedia
] as const;

export interface ImportDeps {
	db: DB;
	lab: Lab;
	models: ModelStore;
	fetch: Fetcher;
	thingiverseToken: () => string;
	ffmpeg: () => string | null;
	log?: (message: string) => void;
}

export class ImportService {
	private cache = new Map<string, { at: number; loaded: LoadedModel; token: string }>();
	private sketches: SketchStore;

	constructor(private d: ImportDeps) {
		this.sketches = new SketchStore(d.db, d.lab);
	}

	private link(url: string): ModelLink {
		const link = parseModelLink(url);
		if (!link)
			throw new AppError(
				400,
				'Paste a model page link from Printables, Thingiverse or MakerWorld.'
			);
		return link;
	}

	private async load(link: ModelLink, signal?: AbortSignal) {
		const token = this.d.thingiverseToken();
		const key = `${link.site}:${link.id}`;
		const hit = this.cache.get(key);
		if (hit && Date.now() - hit.at < CACHE_MS && hit.token === token) return hit.loaded;
		const loaded = await SITES[link.site].load(link, {
			fetch: this.d.fetch,
			thingiverseToken: token,
			signal
		});
		for (const [k, v] of this.cache) if (Date.now() - v.at >= CACHE_MS) this.cache.delete(k);
		if (this.cache.size > 30) this.cache.delete(this.cache.keys().next().value!);
		this.cache.set(key, { at: Date.now(), loaded, token });
		return loaded;
	}

	async preview(input: unknown, signal?: AbortSignal): Promise<ImportPreview> {
		const { url } = parse(previewInput, input);
		return (await this.load(this.link(url), signal)).preview;
	}

	/** A preview picture, through the allowlisted fetch (the page's CSP keeps remote images out). */
	async image(url: string, signal?: AbortSignal) {
		const res = await this.d.fetch(url, { allow: IMAGE_HOSTS, kind: 'image', signal });
		return { type: res.type, body: res.body };
	}

	/** Sources recorded for a project (credits), newest first. */
	sources(projectId: string) {
		return this.d.db
			.select()
			.from(projectSources)
			.where(eq(projectSources.projectId, projectId))
			.all()
			.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
	}

	async confirm(input: unknown, signal?: AbortSignal): Promise<ImportResult> {
		const body = parse(confirmInput, input);
		const loaded = await this.load(this.link(body.url), signal);
		const p = loaded.preview;
		const chosen = body.files.map((id) => {
			const file = p.files.find((f) => f.id === id);
			if (!file) throw new AppError(400, 'One of the chosen files is not part of this model.');
			if (!file.format) throw new AppError(400, `“${file.name}” is not an STL, 3MF or OBJ file.`);
			return { ...file, format: file.format };
		});
		if (chosen.length && !p.downloadable)
			throw new AppError(400, p.note ?? 'Files from this model cannot be downloaded here.');

		const credit = creditText(p);
		let projectId = body.projectId ?? null;
		let created = false;
		if (projectId) {
			const project = this.d.db.select().from(projects).where(eq(projects.id, projectId)).get();
			if (!project) throw new AppError(404, 'That project no longer exists.');
			const known = this.d.db
				.select({ id: projectSources.id })
				.from(projectSources)
				.where(and(eq(projectSources.projectId, projectId), eq(projectSources.url, p.url)))
				.get();
			// Every field is sent: the patch schema fills left-out fields with their defaults.
			if (!known && !project.description.includes(credit))
				this.d.lab.updateProject(projectId, {
					version: project.version,
					profileId: project.profileId,
					title: project.title,
					status: project.status,
					category: project.category,
					description: withCredit(project.description, credit),
					notes: project.notes,
					url: project.url || p.url,
					files: project.files,
					material: project.material,
					pinned: project.pinned
				});
		} else {
			if (!body.profileId) throw new AppError(400, 'Choose who the project is for.');
			projectId = this.d.lab.createProject({
				profileId: body.profileId,
				title: p.title.slice(0, 80),
				description: withCredit(p.description, credit),
				url: p.url
			});
			created = true;
		}

		const skipped: ImportResult['skipped'] = [];
		const modelIds: string[] = [];
		for (const file of chosen) {
			try {
				const buf = await loaded.download(file.id, this.d.fetch, signal);
				const name = file.name.replace(/\.[^.]+$/, '').slice(0, 80) || p.title.slice(0, 80);
				modelIds.push(this.d.models.importFile(projectId, name, buf, file.format));
			} catch (error) {
				if (signal?.aborted) throw error;
				skipped.push({ name: file.name, reason: (error as Error).message });
			}
		}

		const images: { url: string; sketchId: string | null }[] = p.images
			.slice(0, MAX_PICTURES)
			.map((url) => ({ url, sketchId: null }));
		let pictures = 0;
		if (body.pictures !== false && images.length) {
			const ffmpeg = this.d.ffmpeg();
			for (const [i, img] of images.entries()) {
				try {
					const res = await this.d.fetch(img.url, {
						allow: loaded.imageHosts,
						kind: 'image',
						signal
					});
					const png = await toPng(res.body, ffmpeg);
					if (!png) {
						skipped.push({
							name: `Picture ${i + 1}`,
							reason: ffmpeg
								? 'Could not convert the picture.'
								: 'Install ffmpeg to keep JPEG and WebP pictures.'
						});
						continue;
					}
					img.sketchId = this.sketches.create(
						projectId,
						png,
						`Picture ${i + 1} from ${SITE_NAME[p.site]}`
					);
					pictures++;
				} catch (error) {
					if (signal?.aborted) throw error;
					skipped.push({ name: `Picture ${i + 1}`, reason: (error as Error).message });
				}
			}
		}

		const row = {
			site: p.site,
			url: p.url,
			title: p.title,
			author: p.author,
			authorUrl: p.authorUrl,
			licence: p.licence ?? p.terms.code,
			licenceUrl: p.licenceUrl,
			images,
			importedAt: new Date().toISOString()
		};
		const existing = this.d.db
			.select({ id: projectSources.id })
			.from(projectSources)
			.where(and(eq(projectSources.projectId, projectId), eq(projectSources.url, p.url)))
			.get();
		if (existing)
			this.d.db.update(projectSources).set(row).where(eq(projectSources.id, existing.id)).run();
		else
			this.d.db
				.insert(projectSources)
				.values({ id: crypto.randomUUID(), projectId, ...row })
				.run();
		this.d.lab.touch('project', `Imported from ${SITE_NAME[p.site]}`, projectId);
		this.d.log?.(`Imported ${p.url}: ${modelIds.length} files, ${pictures} pictures`);
		return { projectId, created, modelIds, pictures, skipped };
	}
}
