// Model import from a pasted link (Printables, Thingiverse, MakerWorld): the preview the server builds,
// what a confirmed import returns, link recognition, licence meanings in plain words and the credit
// text added to a project. Pure, shared by the server and the UI.

export const IMPORT_SITES = ['printables', 'thingiverse', 'makerworld'] as const;
export type ImportSite = (typeof IMPORT_SITES)[number];
export const SITE_NAME: Record<ImportSite, string> = {
	printables: 'Printables',
	thingiverse: 'Thingiverse',
	makerworld: 'MakerWorld'
};

/** File types the lab imports as models (ModelStore.importFile). */
export const IMPORTABLE = ['stl', '3mf', 'obj'] as const;
export type ImportableFormat = (typeof IMPORTABLE)[number];
export const MAX_MODEL_BYTES = 100_000_000;

export function fileFormat(name: string): ImportableFormat | null {
	const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
	return IMPORTABLE.includes(ext as ImportableFormat) ? (ext as ImportableFormat) : null;
}

export interface ModelLink {
	site: ImportSite;
	/** The model's id on that site. */
	id: string;
	/** The link without tracking parameters, as stored in credits. */
	url: string;
}

/**
 * Recognises a model page link. Printables: /model/<id>-<slug> (optionally under a language prefix);
 * Thingiverse: /thing:<id>; MakerWorld: /<lang>/models/<id>-<slug>. Anything else is null.
 */
export function parseModelLink(input: string): ModelLink | null {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
	const host = url.hostname.toLowerCase().replace(/^www\./, '');
	if (host === 'printables.com') {
		const m = url.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?model\/(\d+)(-[\w-]*)?/i);
		if (m) return { site: 'printables', id: m[1], url: `https://www.printables.com/model/${m[1]}` };
	}
	if (host === 'thingiverse.com') {
		const m = url.pathname.match(/^\/thing:(\d+)/);
		if (m)
			return { site: 'thingiverse', id: m[1], url: `https://www.thingiverse.com/thing:${m[1]}` };
	}
	if (host === 'makerworld.com') {
		const m = url.pathname.match(/^\/(?:([a-z]{2}(?:-[a-z]{2})?)\/)?models\/(\d+)(-[\w-]*)?/i);
		if (m)
			return {
				site: 'makerworld',
				id: m[2],
				url: `https://makerworld.com/${m[1] ?? 'en'}/models/${m[2]}${m[3] ?? ''}`
			};
	}
	return null;
}

// ---------- Licences ----------

export interface LicenceTerms {
	/** Short name, e.g. "CC BY-NC-SA", or the site's own name when unknown. */
	code: string;
	/** Link to the licence text, when we know it. */
	url: string | null;
	/** Selling prints or files allowed (null: unknown). */
	commercial: boolean | null;
	/** Sharing changed versions allowed (null: unknown). */
	remix: boolean | null;
	/** Remixes must use the same licence. */
	shareAlike: boolean;
	/** The designer must be credited. */
	attribution: boolean;
	/** What it means, in plain words, one sentence each. */
	meaning: string[];
	/** Restrictions a parent should notice (non-commercial, no remixes, unknown). */
	caution: boolean;
}

const CC = (path: string) => `https://creativecommons.org/licenses/${path}/4.0/`;

/**
 * Classifies a licence as the sites name it: Printables ("Creative Commons — Attribution — Noncommercial",
 * abbreviation "CC-BY-NC"), Thingiverse ("Creative Commons - Attribution - Non-Commercial", "GNU - GPL")
 * and MakerWorld ("BY-NC-SA", "Standard Digital File License").
 */
export function classifyLicence(name: string | null | undefined): LicenceTerms {
	const raw = (name ?? '').trim();
	const s = raw.toUpperCase().replace(/[—–]/g, '-').replace(/\s+/g, ' ');
	const words = s.replace(/[^A-Z0-9]+/g, ' ').trim();
	const has = (re: RegExp) => re.test(words);
	const base = { shareAlike: false, attribution: false };
	if (!raw)
		return {
			code: 'Unknown licence',
			url: null,
			commercial: null,
			remix: null,
			...base,
			meaning: [
				'The site did not say. Check the model page before sharing files or selling prints.'
			],
			caution: true
		};
	if (has(/\bCC0\b|PUBLIC DOMAIN/))
		return {
			code: 'CC0',
			url: 'https://creativecommons.org/publicdomain/zero/1.0/',
			commercial: true,
			remix: true,
			...base,
			meaning: [
				'Free to use for anything, even selling prints. Crediting the designer is still kind.'
			],
			caution: false
		};
	if (has(/STANDARD DIGITAL FILE/))
		return {
			code: 'Standard Digital File License',
			url: null,
			commercial: false,
			remix: false,
			...base,
			attribution: true,
			meaning: [
				'For your own use: print it at home, but do not share the files or sell prints.',
				'Keep the credit to the designer.'
			],
			caution: true
		};
	if (has(/\bLGPL\b|\bGPL\b/)) {
		const lesser = has(/\bLGPL\b/);
		return {
			code: lesser ? 'GNU LGPL' : 'GNU GPL',
			url: lesser
				? 'https://www.gnu.org/licenses/lgpl-3.0.html'
				: 'https://www.gnu.org/licenses/gpl-3.0.html',
			commercial: true,
			remix: true,
			shareAlike: true,
			attribution: true,
			meaning: [
				'Free to use, change and sell.',
				'If you share a changed version, share it under the same licence with its source.'
			],
			caution: false
		};
	}
	if (has(/\bBSD\b|\bMIT\b/))
		return {
			code: has(/\bBSD\b/) ? 'BSD' : 'MIT',
			url: has(/\bBSD\b/)
				? 'https://opensource.org/license/bsd-3-clause'
				: 'https://opensource.org/license/mit',
			commercial: true,
			remix: true,
			...base,
			attribution: true,
			meaning: ['Free to use, change and sell, as long as the credit stays with it.'],
			caution: false
		};
	const cc = has(/CREATIVE COMMONS|\bCC\b|\bBY\b|ATTRIBUTION/);
	if (cc) {
		const nc = has(/\bNC\b|NON ?COMMERCIAL/);
		const nd = has(/\bND\b|NO DERIVATIVE/);
		const sa = has(/\bSA\b|SHARE ALIKE/);
		const parts = ['BY', nc && 'NC', nd && 'ND', sa && !nd && 'SA'].filter(Boolean) as string[];
		const meaning = ['Credit the designer whenever you share it or a photo of your print.'];
		if (nc) meaning.push('Personal use only: do not sell prints or the files.');
		if (nd) meaning.push('You can change it for yourself, but do not share changed versions.');
		if (sa && !nd) meaning.push('If you share a changed version, use this same licence.');
		if (!nc) meaning.push('Selling prints is allowed.');
		return {
			code: `CC ${parts.join('-')}`,
			url: CC(parts.join('-').toLowerCase()),
			commercial: !nc,
			remix: !nd,
			shareAlike: sa && !nd,
			attribution: true,
			meaning,
			caution: nc || nd
		};
	}
	if (has(/ALL RIGHTS RESERVED/))
		return {
			code: 'All rights reserved',
			url: null,
			commercial: false,
			remix: false,
			...base,
			attribution: true,
			meaning: ['Print it for yourself only. Do not share the files, remixes or sell prints.'],
			caution: true
		};
	return {
		code: raw.slice(0, 80),
		url: null,
		commercial: null,
		remix: null,
		...base,
		meaning: ['Check what this licence allows on the model page before sharing or selling.'],
		caution: true
	};
}

// ---------- Preview and results ----------

export interface ImportFile {
	/** The site's file id (what confirm names). */
	id: string;
	name: string;
	/** Bytes, when the site says. */
	size: number | null;
	/** Null when the lab cannot open this type (STEP, F3D, PDF…); shown, not selectable. */
	format: ImportableFormat | null;
}

export interface ImportPreview {
	site: ImportSite;
	id: string;
	/** The model page. */
	url: string;
	title: string;
	author: string | null;
	authorUrl: string | null;
	/** The licence as the site names it. */
	licence: string | null;
	licenceUrl: string | null;
	terms: LicenceTerms;
	/** Plain text, shortened. */
	description: string;
	/** Picture links on the site's image servers (shown through /api/imports/image). */
	images: string[];
	files: ImportFile[];
	/** Whether this app can download the files; otherwise the user downloads them and drops them in. */
	downloadable: boolean;
	/** Why not, or what to do, in plain words. */
	note: string | null;
}

export interface ImportConfirm {
	url: string;
	/** Add to this project; otherwise a new one for `profileId`. */
	projectId?: string | null;
	profileId?: string | null;
	/** File ids from the preview to download. */
	files: string[];
	/** Also save the pictures to the project (default true). */
	pictures?: boolean;
}

export interface ImportResult {
	projectId: string;
	created: boolean;
	modelIds: string[];
	pictures: number;
	/** Files or pictures that could not be brought in, with why. */
	skipped: { name: string; reason: string }[];
}

export interface ImportSettingsView {
	/** A Thingiverse app token is saved (the token itself never leaves the server). */
	hasThingiverseToken: boolean;
}

// ---------- Credits ----------

/** The credit block added to the project's description; never shortened. */
export function creditText(p: {
	site: ImportSite;
	url: string;
	title: string;
	author: string | null;
	authorUrl: string | null;
	terms: LicenceTerms;
	licence: string | null;
}) {
	const lines = [
		`“${p.title}” by ${p.author ?? 'an unnamed designer'}${p.authorUrl ? ` (${p.authorUrl})` : ''}, from ${SITE_NAME[p.site]}: ${p.url}`,
		`Licence: ${p.licence && p.licence !== p.terms.code ? `${p.licence} (${p.terms.code})` : p.terms.code}${p.terms.url ? ` ${p.terms.url}` : ''}`
	];
	if (p.terms.caution) lines.push(p.terms.meaning.join(' '));
	return `Credits\n${lines.join('\n')}`;
}

/**
 * Description with the credit appended. The credit is kept whole; the rest is shortened to fit `max`
 * (the project description limit).
 */
export function withCredit(description: string, credit: string, max = 4000) {
	const sep = '\n\n';
	const room = max - credit.length - sep.length;
	const body = description.trim();
	if (!body) return credit.slice(0, max);
	if (room <= 1) return credit.slice(0, max);
	const fitted = body.length > room ? `${body.slice(0, room - 1).trimEnd()}…` : body;
	return `${fitted}${sep}${credit}`;
}

/** HTML (Printables, Thingiverse descriptions) to short plain text. */
export function plainText(html: string, max = 1500) {
	const text = html
		.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|h\d|li|div)>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;|&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/[ \t]+/g, ' ')
		.replace(/ *\n */g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
