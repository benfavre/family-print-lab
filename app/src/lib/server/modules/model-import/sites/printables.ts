// Printables: the public GraphQL API the site itself uses (https://api.printables.com/graphql/). The
// query and mutation below were checked against the live API on 2026-09-27 (introspection is off, so
// the names come from the site's own requests, also used by github.com/seasick/openscad-web-gui
// src/lib/fetcha/printables.com.ts): `print(id)` for details, `getDownloadLink` for a file's link on
// files.printables.com. Two requests per preview at most; one per chosen file on import.
import { AppError } from '$lib/server/validation';
import {
	classifyLicence,
	fileFormat,
	plainText,
	type ImportFile,
	type ImportPreview,
	type ModelLink
} from '$lib/shared/model-import';
import { HOSTS, type Fetcher } from '../fetch';
import type { LoadedModel, Site } from './types';

const API = 'https://api.printables.com/graphql/';

export const PRINT_QUERY = `query PrintProfile($id: ID!) { print(id: $id) { id name slug summary description authorship premium price license { id name abbreviation disallowRemixing } user { id publicUsername handle } images { id filePath } stls { id name fileSize } otherFiles { id name fileSize } } }`;

const DOWNLOAD_MUTATION = `mutation GetDownloadLink($id: ID!, $printId: ID!, $fileType: DownloadFileTypeEnum!, $source: DownloadSourceEnum!) { getDownloadLink(id: $id, printId: $printId, fileType: $fileType, source: $source) { ok errors { field messages } output { link } } }`;

interface PrintFile {
	id: string;
	name: string | null;
	fileSize: number | null;
}
export interface PrintData {
	id: string;
	name: string | null;
	slug: string | null;
	summary: string | null;
	description: string | null;
	premium: boolean | null;
	price: number | null;
	license: { name: string | null; abbreviation: string | null } | null;
	user: { publicUsername: string | null; handle: string | null } | null;
	images: { id: string; filePath: string }[] | null;
	stls: PrintFile[] | null;
	otherFiles: PrintFile[] | null;
}

/**
 * A picture's 1280×960 JPEG version (the full photos are often over the 5 MB cap). The
 * `thumbs/inside/<w>x<h>/jpg/<name>.jpg` form is what the site serves for its gallery (checked 2026-09-27).
 */
export function printablesImage(filePath: string) {
	const clean = filePath.replace(/^\/+/, '');
	const dir = clean.slice(0, clean.lastIndexOf('/'));
	const base = clean.slice(clean.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
	return `https://media.printables.com/${dir}/thumbs/inside/1280x960/jpg/${base}.jpg`;
}

/** Builds the preview from a `print` query answer (pure; tested with saved answers). */
export function printablesPreview(link: ModelLink, print: PrintData): ImportPreview {
	const licence = print.license?.name?.replace(/\s+/g, ' ').trim() || null;
	const terms = classifyLicence(print.license?.abbreviation || licence);
	const paid = !!print.premium || (print.price ?? 0) > 0;
	const files: ImportFile[] = [
		...(print.stls ?? []).map((f) => ({ ...f, kind: 'stl' })),
		...(print.otherFiles ?? []).map((f) => ({ ...f, kind: 'other' }))
	].map((f) => ({
		id: `${f.kind}:${f.id}`,
		name: f.name || `File ${f.id}`,
		size: f.fileSize ?? null,
		format: fileFormat(f.name ?? '')
	}));
	const handle = print.user?.handle;
	return {
		site: 'printables',
		id: print.id,
		url: `https://www.printables.com/model/${print.id}${print.slug ? `-${print.slug}` : ''}`,
		title: print.name?.trim() || `Printables model ${print.id}`,
		author: print.user?.publicUsername || handle || null,
		authorUrl: handle ? `https://www.printables.com/@${encodeURIComponent(handle)}` : null,
		licence,
		licenceUrl: terms.url,
		terms,
		description: plainText(print.description || print.summary || ''),
		images: (print.images ?? []).slice(0, 12).map((i) => printablesImage(i.filePath)),
		files,
		downloadable: !paid,
		note: paid
			? 'This is a paid model. Buy it on Printables, download it in your browser, then drop the file here.'
			: null
	};
}

async function graphql<T>(fetch: Fetcher, body: object, signal?: AbortSignal): Promise<T> {
	const res = await fetch(API, {
		allow: HOSTS.printables,
		kind: 'json',
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
		signal
	});
	let data: { data?: T; errors?: { message: string }[] };
	try {
		data = JSON.parse(res.body.toString('utf8'));
	} catch {
		throw new AppError(502, 'Printables sent an answer this app does not understand.');
	}
	if (!data.data)
		throw new AppError(
			502,
			`Printables could not answer: ${data.errors?.[0]?.message ?? 'no data'}`
		);
	return data.data;
}

export const printables: Site = {
	async load(link, ctx): Promise<LoadedModel> {
		const data = await graphql<{ print: PrintData | null }>(
			ctx.fetch,
			{ operationName: 'PrintProfile', query: PRINT_QUERY, variables: { id: link.id } },
			ctx.signal
		);
		if (!data.print) throw new AppError(404, 'Printables has no model at that link.');
		const preview = printablesPreview(link, data.print);
		return {
			preview,
			imageHosts: HOSTS.printablesMedia,
			async download(fileId, fetch, signal) {
				const [kind, id] = fileId.split(':');
				const answer = await graphql<{
					getDownloadLink: {
						ok: boolean;
						errors?: { messages?: string[] | null }[] | null;
						output: { link: string } | null;
					} | null;
				}>(
					fetch,
					{
						operationName: 'GetDownloadLink',
						query: DOWNLOAD_MUTATION,
						variables: {
							id,
							printId: preview.id,
							fileType: kind === 'stl' ? 'stl' : 'other',
							source: 'model_detail'
						}
					},
					signal
				);
				const url = answer.getDownloadLink?.output?.link;
				if (!answer.getDownloadLink?.ok || !url) {
					// e.g. "files_cannot_be_downloaded" (seen from the live API for a file id that is not the model's)
					const why = answer.getDownloadLink?.errors?.flatMap((e) => e.messages ?? []).join(', ');
					throw new AppError(
						502,
						`Printables did not give a download link for this file${why ? ` (${why})` : ''}.`
					);
				}
				return (await fetch(url, { allow: HOSTS.printablesFiles, kind: 'model', signal })).body;
			}
		};
	}
};
