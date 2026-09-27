// Thingiverse: the REST API (https://api.thingiverse.com) with the user's own app token, sent as
// `Authorization: Bearer` (BearerAuth in the API's OpenAPI description, mirrored at
// github.com/nomike/thingiverse-client openapi/openapi.yaml). GET /things/{id}, /things/{id}/files and
// /things/{id}/images; field names from its schemas (thing_schema, file_schema, image_summary_schema).
// Without a token the preview says how to add one and the user can still drop files in.
import { AppError } from '$lib/server/validation';
import {
	classifyLicence,
	fileFormat,
	plainText,
	type ImportPreview,
	type ModelLink
} from '$lib/shared/model-import';
import { HOSTS, type Fetcher } from '../fetch';
import type { LoadedModel, Site } from './types';

const API = 'https://api.thingiverse.com';

export interface ThingData {
	id: number;
	name: string;
	public_url?: string | null;
	creator?: { name?: string | null; public_url?: string | null } | null;
	license?: string | null;
	description?: string | null;
	description_html?: string | null;
}
export interface ThingFile {
	id: number;
	name: string;
	size?: number | null;
	download_url?: string | null;
	/** On cdn.thingiverse.com; null for files outside the printable list (file_schema). */
	direct_url?: string | null;
}
export interface ThingImage {
	url?: string | null;
	sizes?: { type?: string; size?: string; url?: string }[] | null;
}

/** The largest display picture, or the original. */
function imageUrl(i: ThingImage) {
	const pick = (type: string, size: string) =>
		i.sizes?.find((s) => s.type === type && s.size === size)?.url;
	return (
		pick('display', 'large') ??
		pick('preview', 'featured') ??
		pick('thumb', 'large') ??
		i.url ??
		null
	);
}

const onCdn = (url: string | null | undefined): url is string => {
	try {
		return (
			!!url && new URL(url).protocol === 'https:' && new URL(url).hostname === 'cdn.thingiverse.com'
		);
	} catch {
		return false;
	}
};

/** Builds the preview from API answers (pure; tested with saved answers). */
export function thingiversePreview(
	link: ModelLink,
	thing: ThingData,
	files: ThingFile[],
	images: ThingImage[]
): ImportPreview {
	const terms = classifyLicence(thing.license);
	return {
		site: 'thingiverse',
		id: String(thing.id),
		url: link.url,
		title: thing.name?.trim() || `Thingiverse thing ${thing.id}`,
		author: thing.creator?.name || null,
		authorUrl: thing.creator?.public_url || null,
		licence: thing.license || null,
		licenceUrl: terms.url,
		terms,
		description: plainText(thing.description_html || thing.description || ''),
		images: images.map(imageUrl).filter(onCdn).slice(0, 12),
		files: files.map((f) => ({
			id: String(f.id),
			name: f.name,
			size: f.size ?? null,
			format: fileFormat(f.name)
		})),
		downloadable: true,
		note: null
	};
}

/** What the preview shows without a token: the link, and how to continue. */
export function thingiverseWithoutToken(link: ModelLink): ImportPreview {
	const terms = classifyLicence(null);
	return {
		site: 'thingiverse',
		id: link.id,
		url: link.url,
		title: `Thingiverse thing ${link.id}`,
		author: null,
		authorUrl: null,
		licence: null,
		licenceUrl: null,
		terms,
		description: '',
		images: [],
		files: [],
		downloadable: false,
		note: 'Thingiverse only answers apps with a token. Add your own free app token in Integrations → Model links to see the details and download here, or download in your browser and drop the file here.'
	};
}

async function getJson<T>(fetch: Fetcher, path: string, token: string, signal?: AbortSignal) {
	const res = await fetch(`${API}${path}`, {
		allow: HOSTS.thingiverse,
		kind: 'json',
		headers: { authorization: `Bearer ${token}` },
		signal
	});
	try {
		return JSON.parse(res.body.toString('utf8')) as T;
	} catch {
		throw new AppError(502, 'Thingiverse sent an answer this app does not understand.');
	}
}

export const thingiverse: Site = {
	async load(link, ctx): Promise<LoadedModel> {
		const token = ctx.thingiverseToken;
		const none = async (): Promise<Buffer> => {
			throw new AppError(400, 'Add a Thingiverse app token first.');
		};
		if (!token) return { preview: thingiverseWithoutToken(link), imageHosts: [], download: none };
		// One after the other, to stay gentle with the API's rate limit.
		const thing = await getJson<ThingData>(ctx.fetch, `/things/${link.id}`, token, ctx.signal);
		const files = await getJson<ThingFile[]>(
			ctx.fetch,
			`/things/${link.id}/files`,
			token,
			ctx.signal
		);
		const images = await getJson<ThingImage[]>(
			ctx.fetch,
			`/things/${link.id}/images`,
			token,
			ctx.signal
		).catch(() => []);
		const preview = thingiversePreview(link, thing, Array.isArray(files) ? files : [], images);
		const byId = new Map((Array.isArray(files) ? files : []).map((f) => [String(f.id), f]));
		return {
			preview,
			imageHosts: HOSTS.thingiverseCdn,
			async download(fileId, fetch, signal) {
				const file = byId.get(fileId);
				if (!file) throw new AppError(404, 'That file is not part of this model.');
				// The CDN link needs no token; the API link redirects to the CDN, and the token is dropped there.
				if (onCdn(file.direct_url))
					return (
						await fetch(file.direct_url, { allow: HOSTS.thingiverseCdn, kind: 'model', signal })
					).body;
				return (
					await fetch(`${API}/files/${file.id}/download`, {
						allow: [...HOSTS.thingiverse, ...HOSTS.thingiverseCdn],
						kind: 'model',
						headers: { authorization: `Bearer ${token}` },
						signal
					})
				).body;
			}
		};
	}
};
