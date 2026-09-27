// Test helpers: saved site answers and a scripted fetcher (no network).
import fs from 'node:fs';
import path from 'node:path';
import { checkUrl, type Fetched, type Fetcher, type FetchOptions } from './fetch';

const DIR = path.join(import.meta.dirname, '__fixtures__');
export const fixture = (name: string) => fs.readFileSync(path.join(DIR, name), 'utf8');
export const fixtureJson = <T = unknown>(name: string) => JSON.parse(fixture(name)) as T;

export type Answer = { type: string; body: string | Buffer } | ((o: FetchOptions) => Fetched);

/**
 * A fetcher that answers from a table (keys are URLs; POST bodies to the Printables API are answered
 * by operation name as `graphql:<operationName>`). It still applies the host allowlist, so tests catch
 * a site adapter asking the wrong host. `calls` lists what was asked.
 */
export function scriptedFetch(answers: Record<string, Answer>) {
	const calls: { url: string; o: FetchOptions }[] = [];
	const fetch: Fetcher = async (input, o) => {
		const url = checkUrl(input, o.allow);
		calls.push({ url: url.href, o });
		let key = url.href;
		if (o.method === 'POST' && o.body) key = `graphql:${JSON.parse(o.body).operationName}`;
		const a = answers[key];
		if (!a) throw Object.assign(new Error(`No answer for ${key}`), { status: 502 });
		if (typeof a === 'function') return a(o);
		return {
			url,
			status: 200,
			type: a.type,
			body: Buffer.isBuffer(a.body) ? a.body : Buffer.from(a.body)
		};
	};
	return { fetch, calls };
}

/** A one-triangle ASCII STL. */
export const TRIANGLE_STL =
	'solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid t\n';

/** The smallest PNG header a sketch accepts (signature + IHDR size). */
export function tinyPng(width = 4, height = 3) {
	const b = Buffer.alloc(33);
	Buffer.from('89504e470d0a1a0a', 'hex').copy(b, 0);
	b.writeUInt32BE(13, 8);
	b.write('IHDR', 12, 'latin1');
	b.writeUInt32BE(width, 16);
	b.writeUInt32BE(height, 20);
	return b;
}
