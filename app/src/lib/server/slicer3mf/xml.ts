// A small, forgiving XML reader for the files inside a 3MF: elements, attributes, text and the source
// offsets of every element (so parts we do not model can be kept verbatim). Attribute values are not
// whitespace-normalised, because Bambu Studio reads its config files with boost::property_tree, which
// keeps newlines (custom G-code lives in attributes). Large meshes are not parsed here: `raw` elements
// keep only their source range and are scanned by mesh.ts.

export interface XmlNode {
	name: string;
	attrs: Record<string, string>;
	children: XmlNode[];
	/** Text directly inside the element (entities decoded). */
	text: string;
	/** Source range of the whole element, from '<' to after its closing '>'. */
	start: number;
	end: number;
	/** Source range of the content between the tags (empty for self-closing elements). */
	innerStart: number;
	innerEnd: number;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Decodes the five XML entities and numeric character references. */
export function decodeEntities(s: string): string {
	if (!s.includes('&')) return s;
	return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
		if (e[0] === '#') {
			const code =
				e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
		}
		return ENTITIES[e] ?? m;
	});
}

/** Escapes text for an attribute value or element content (quotes included, like upstream's xml_escape). */
export function escapeXml(s: string): string {
	return s.replace(/[&<>"']/g, (c) =>
		c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&apos;'
	);
}

const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Parses the attributes of one start tag's inside (after the name). */
export function parseAttrs(s: string): Record<string, string> {
	const out: Record<string, string> = {};
	ATTR.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = ATTR.exec(s))) out[m[1]] = decodeEntities(m[2] ?? m[3] ?? '');
	return out;
}

export class XmlError extends Error {}

/**
 * Parses a document into its root element. Elements named in `raw` are not descended into: their
 * children stay empty and their content is left for the caller (offsets are set).
 */
export function parseXml(text: string, raw: ReadonlySet<string> = new Set()): XmlNode {
	const root: XmlNode = {
		name: '#document',
		attrs: {},
		children: [],
		text: '',
		start: 0,
		end: text.length,
		innerStart: 0,
		innerEnd: text.length
	};
	const stack: XmlNode[] = [root];
	let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
	while (i < text.length) {
		const lt = text.indexOf('<', i);
		const top = stack[stack.length - 1];
		if (lt < 0) {
			top.text += decodeEntities(text.slice(i));
			break;
		}
		if (lt > i) top.text += decodeEntities(text.slice(i, lt));
		if (text.startsWith('<!--', lt)) {
			const end = text.indexOf('-->', lt + 4);
			i = end < 0 ? text.length : end + 3;
		} else if (text.startsWith('<![CDATA[', lt)) {
			const end = text.indexOf(']]>', lt + 9);
			top.text += text.slice(lt + 9, end < 0 ? text.length : end);
			i = end < 0 ? text.length : end + 3;
		} else if (text[lt + 1] === '?' || text[lt + 1] === '!') {
			const end = text.indexOf('>', lt);
			i = end < 0 ? text.length : end + 1;
		} else if (text[lt + 1] === '/') {
			const end = text.indexOf('>', lt);
			if (end < 0) throw new XmlError('Unclosed end tag.');
			const name = text.slice(lt + 2, end).trim();
			// Tolerate stray end tags; close up to the matching open element.
			let k = stack.length - 1;
			while (k > 0 && stack[k].name !== name) k--;
			if (k > 0) {
				for (let j = stack.length - 1; j > k; j--) stack[j].innerEnd = stack[j].end = lt;
				stack[k].innerEnd = lt;
				stack[k].end = end + 1;
				stack.length = k;
			}
			i = end + 1;
		} else {
			const end = findTagEnd(text, lt + 1);
			if (end < 0) throw new XmlError('Unclosed start tag.');
			const selfClosing = text[end - 1] === '/';
			const inner = text.slice(lt + 1, selfClosing ? end - 1 : end);
			const sp = inner.search(/[\s/]/);
			const name = sp < 0 ? inner : inner.slice(0, sp);
			const node: XmlNode = {
				name,
				attrs: sp < 0 ? {} : parseAttrs(inner.slice(sp)),
				children: [],
				text: '',
				start: lt,
				end: end + 1,
				innerStart: end + 1,
				innerEnd: end + 1
			};
			top.children.push(node);
			i = end + 1;
			if (!selfClosing) {
				if (raw.has(name)) {
					const close = text.indexOf(`</${name}`, i);
					if (close < 0) throw new XmlError(`Unclosed <${name}>.`);
					const closeEnd = text.indexOf('>', close);
					node.innerEnd = close;
					node.end = closeEnd + 1;
					i = closeEnd + 1;
				} else stack.push(node);
			}
		}
	}
	return root;
}

/** The end ('>') of a tag starting at `from`, skipping '>' inside quoted attribute values. */
function findTagEnd(text: string, from: number): number {
	let quote = '';
	for (let i = from; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === quote) quote = '';
		} else if (c === '"' || c === "'") quote = c;
		else if (c === '>') return i;
	}
	return -1;
}

/** The document's root element (the first element child). */
export function rootElement(doc: XmlNode): XmlNode {
	const el = doc.children[0];
	if (!el) throw new XmlError('Empty XML document.');
	return el;
}

/** Child elements with that name. */
export const childrenNamed = (n: XmlNode, name: string) =>
	n.children.filter((c) => c.name === name);
export const child = (n: XmlNode, name: string) => n.children.find((c) => c.name === name);

/** Upstream's xml_unescape (src/libslic3r/utils.cpp): only &lt; &gt; and &amp;. */
export function xmlUnescape(s: string): string {
	return s.includes('&') ? s.replace(/&(lt|gt|amp);/g, (_, e: string) => ENTITIES[e]) : s;
}

const NAME = /^[A-Za-z_][\w.:-]*$/;
/** An XML name (element or attribute), as the writer may put it in a tag. */
export const isXmlName = (s: string) => NAME.test(s);

/**
 * Checks XML the browser sends back verbatim (unmodelled elements, cut information): tags balance,
 * names are names, attribute values are quoted and text has no stray '<'. Returns how many elements
 * sit at the top level, or -1 when it is not well-formed enough to paste into a file we write.
 */
export function xmlFragmentElements(s: string): number {
	const stack: string[] = [];
	let top = 0;
	let i = 0;
	while (i < s.length) {
		const lt = s.indexOf('<', i);
		const text = s.slice(i, lt < 0 ? s.length : lt);
		if (!stack.length && text.trim()) return -1;
		if (/&(?!(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);)/.test(text)) return -1;
		if (lt < 0) break;
		if (s.startsWith('<!--', lt)) {
			const end = s.indexOf('-->', lt + 4);
			if (end < 0) return -1;
			i = end + 3;
		} else if (s.startsWith('<![CDATA[', lt)) {
			const end = s.indexOf(']]>', lt + 9);
			if (end < 0 || !stack.length) return -1;
			i = end + 3;
		} else if (s[lt + 1] === '/') {
			const end = s.indexOf('>', lt);
			if (end < 0 || stack.pop() !== s.slice(lt + 2, end).trim()) return -1;
			i = end + 1;
		} else {
			const end = findTagEnd(s, lt + 1);
			if (end < 0) return -1;
			const selfClosing = s[end - 1] === '/';
			const inner = s.slice(lt + 1, selfClosing ? end - 1 : end);
			const sp = inner.search(/\s/);
			const name = sp < 0 ? inner : inner.slice(0, sp);
			if (!isXmlName(name)) return -1;
			// Everything after the name must be name="value" pairs.
			const rest = sp < 0 ? '' : inner.slice(sp);
			if (rest.replace(/\s+[A-Za-z_][\w.:-]*\s*=\s*("[^"<]*"|'[^'<]*')/g, '').trim()) return -1;
			if (!stack.length) top++;
			if (!selfClosing) stack.push(name);
			i = end + 1;
		}
	}
	return stack.length ? -1 : top;
}
