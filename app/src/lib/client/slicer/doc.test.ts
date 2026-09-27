import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyProject } from '$lib/shared/slicer/project';
import { SlicerDoc } from './doc.svelte';

const project = () =>
	emptyProject({
		printer: { kind: 'printer', name: '', source: 'system' },
		process: { kind: 'process', name: '', source: 'system' },
		filaments: []
	});

/** A server that keeps a revision and refuses saves made against an older one (If-Match). */
function server(start = 1) {
	let revision = start;
	const seen: string[] = [];
	const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
		const match = (init.headers as Record<string, string>)['if-match'];
		seen.push(match);
		await new Promise((r) => setTimeout(r, 5));
		if (Number(match) !== revision)
			return new Response(JSON.stringify({ error: 'Changed elsewhere.' }), { status: 409 });
		revision++;
		return new Response(JSON.stringify({ slicerProject: { revision } }), { status: 200 });
	});
	vi.stubGlobal('fetch', fetchMock);
	return { seen, fetchMock, revision: () => revision };
}

describe('saving the workspace project', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('sends one save at a time with the latest revision, however many callers wait', async () => {
		const s = server();
		const doc = new SlicerDoc('sp1', project(), 1);
		doc.edit('One', (p) => void (p.plates[0].name = 'A'));
		const first = doc.save();
		doc.edit('Two', (p) => void (p.plates[0].name = 'B'));
		// Opening in Bambu Studio and slicing at once: both wait for the save in flight.
		const [a, b, c] = await Promise.all([first, doc.save(), doc.save()]);
		expect([a, b, c]).toEqual([true, true, true]);
		expect(s.seen).toEqual(['1', '2']);
		expect(doc).toMatchObject({ revision: 3, dirty: false, problem: '' });
		doc.dispose();
	});

	it('keeps a conflict as the problem and does not save over it', async () => {
		server(5);
		const doc = new SlicerDoc('sp1', project(), 4);
		doc.edit('One', (p) => void (p.plates[0].name = 'A'));
		expect(await doc.save()).toBe(false);
		expect(doc.problem).toBe('Changed elsewhere.');
		expect(doc.dirty).toBe(true);
		doc.dispose();
	});
});
