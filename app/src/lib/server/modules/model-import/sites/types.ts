import type { ImportPreview, ModelLink } from '$lib/shared/model-import';
import type { Fetcher } from '../fetch';

/** A loaded model page: the preview the user sees and how to get each of its files. */
export interface LoadedModel {
	preview: ImportPreview;
	/** Hosts its pictures may come from. */
	imageHosts: readonly string[];
	/** Downloads one file from the preview (only when `preview.downloadable`). */
	download(fileId: string, fetch: Fetcher, signal?: AbortSignal): Promise<Buffer>;
}

export interface SiteContext {
	fetch: Fetcher;
	/** The user's Thingiverse app token, or ''. */
	thingiverseToken: string;
	signal?: AbortSignal;
}

export interface Site {
	load(link: ModelLink, ctx: SiteContext): Promise<LoadedModel>;
}
