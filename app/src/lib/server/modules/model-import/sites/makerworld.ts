// MakerWorld: public page metadata only. The model page is a Next.js page whose server-rendered data
// sits in <script id="__NEXT_DATA__"> at props.pageProps.design (title, summary, license, designCreator
// {name, handle}, coverUrl, designExtension.design_pictures[].url), as read by
// github.com/fishpen0/manyfold-importer content-scripts/makerworld.js and
// github.com/farazha2203/3dprinthub store/makerworld_next_data.py; Open Graph tags are the fallback.
// Files need a signed-in browser, so the user downloads them there and drops them in. MakerWorld often
// shows a bot check to servers; the preview then falls back to what the link itself says.
import {
	classifyLicence,
	plainText,
	type ImportPreview,
	type ModelLink
} from '$lib/shared/model-import';
import { AppError } from '$lib/server/validation';
import { HOSTS } from '../fetch';
import type { LoadedModel, Site } from './types';

interface Design {
	id?: number | string;
	title?: string;
	summary?: string;
	license?: string;
	coverUrl?: string;
	designCreator?: { name?: string; handle?: string } | null;
	designExtension?: { design_pictures?: { url?: string }[] | null } | null;
}

const DROP_NOTE =
	'MakerWorld only gives files to signed-in browsers. Download the model there, then drop the file here.';

function decode(s: string) {
	return s
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;|&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}

/** `<meta property="og:title" content="…">` in either attribute order. */
function meta(html: string, name: string) {
	const re = new RegExp(
		`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`,
		'i'
	);
	const m = html.match(re);
	return m ? decode(m[1] ?? m[2] ?? '').trim() : '';
}

function nextDesign(html: string): Design | null {
	const m = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
	if (!m) return null;
	try {
		const design = JSON.parse(m[1])?.props?.pageProps?.design;
		return design && typeof design === 'object' ? design : null;
	} catch {
		return null;
	}
}

const onCdn = (url: string | undefined): url is string => {
	try {
		const u = new URL(url ?? '');
		return (
			u.protocol === 'https:' && (HOSTS.makerworldMedia as readonly string[]).includes(u.hostname)
		);
	} catch {
		return false;
	}
};

/** "2344501-printable-snap-lock-keyring" → "Printable snap lock keyring". */
export function titleFromLink(link: ModelLink) {
	const slug = link.url.match(/\/models\/\d+-([\w-]+)/)?.[1];
	if (!slug) return `MakerWorld model ${link.id}`;
	const words = slug.replace(/-+/g, ' ').trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Builds the preview from the page HTML (pure; tested with saved pages). */
export function makerworldPreview(link: ModelLink, html: string | null): ImportPreview {
	const design = html ? nextDesign(html) : null;
	const creator = design?.designCreator;
	const title =
		design?.title?.trim() ||
		(html && meta(html, 'og:title').replace(/\s*[|-]\s*MakerWorld.*$/i, '')) ||
		titleFromLink(link);
	const licence = design?.license?.trim() || null;
	const terms = classifyLicence(licence);
	const pictures = [
		design?.coverUrl,
		...(design?.designExtension?.design_pictures ?? []).map((p) => p?.url),
		html ? meta(html, 'og:image') : undefined
	].filter(onCdn);
	return {
		site: 'makerworld',
		id: link.id,
		url: link.url,
		title,
		author: creator?.name || creator?.handle || null,
		authorUrl: creator?.handle
			? `https://makerworld.com/@${encodeURIComponent(creator.handle)}`
			: null,
		licence,
		licenceUrl: terms.url,
		terms,
		description: plainText(design?.summary || (html ? meta(html, 'og:description') : '')),
		images: [...new Set(pictures)].slice(0, 12),
		files: [],
		downloadable: false,
		note: html
			? DROP_NOTE
			: `MakerWorld did not let this app read the page, so check the designer and licence there. ${DROP_NOTE}`
	};
}

export const makerworld: Site = {
	async load(link, ctx): Promise<LoadedModel> {
		let html: string | null = null;
		try {
			const res = await ctx.fetch(link.url, {
				allow: HOSTS.makerworld,
				kind: 'html',
				headers: { 'accept-language': 'en' },
				signal: ctx.signal
			});
			html = res.body.toString('utf8');
		} catch (error) {
			// A bot check (403) or an outage: continue with what the link says.
			if (!(error instanceof AppError) || error.status === 499) throw error;
		}
		return {
			preview: makerworldPreview(link, html),
			imageHosts: HOSTS.makerworldMedia,
			download: async () => {
				throw new AppError(400, DROP_NOTE);
			}
		};
	}
};
