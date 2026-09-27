// The slicer-profiles module in a test lab (fixture vendor folder, a simulated A1 mini): the API
// routes for user presets, import/export in Bambu Studio's formats, a job's slicer settings, a spool's
// filament preset and the preset for an AMS tray.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { startTestLab, type TestLab } from '../testing/harness';
import { readZip } from '../cad/mesh';
import { FIXTURE } from './__fixtures__/helpers';
import type { SlicerProfiles } from './service';
import * as presetsRoute from '../../../routes/api/slicer/presets/+server';
import * as presetRoute from '../../../routes/api/slicer/presets/[id]/+server';
import * as exportRoute from '../../../routes/api/slicer/presets/[id]/export/+server';
import * as importRoute from '../../../routes/api/slicer/presets/import/+server';
import * as jobRoute from '../../../routes/api/slicer/presets/jobs/[id]/+server';
import * as spoolRoute from '../../../routes/api/slicer/presets/spools/[id]/+server';
import * as profilesRoute from '../../../routes/api/slicer/profiles/+server';
import * as detailRoute from '../../../routes/api/slicer/profiles/preset/+server';
import * as defaultsRoute from '../../../routes/api/slicer/profiles/defaults/+server';
import * as bundleRoute from '../../../routes/api/slicer/profiles/bundle/+server';
import * as trayRoute from '../../../routes/api/slicer/profiles/tray/+server';
import type { UserPreset } from '$lib/shared/slicer/profiles';
import type { JobSliceView, PresetDetail, ProfilesOverview } from '$lib/shared/slicer-profiles';

let t: TestLab;
let s: SlicerProfiles;
const holder = globalThis as Record<symbol, unknown>;
const key = Symbol.for('family-print-lab.runtime');
const A1M = 'Bambu Lab A1 mini 0.4 nozzle';

beforeAll(async () => {
	t = await startTestLab({
		modules: ['slicer-profiles'],
		fleet: ['N1'],
		env: { PRINTLAB_PROFILES_DIR: FIXTURE }
	});
	holder[key] = t.rt;
	s = t.rt.module('slicer-profiles')!.lab;
});
afterAll(async () => {
	delete holder[key];
	await t.stop();
});

type Handler = (e: RequestEvent) => Promise<Response>;
async function call(
	handler: unknown,
	o: {
		url?: string;
		params?: Record<string, string>;
		method?: string;
		body?: unknown;
		raw?: Buffer;
	} = {}
) {
	const url = new URL(o.url ?? '/api/x', 'http://localhost');
	const request = new Request(url, {
		method: o.method ?? 'GET',
		headers: o.raw
			? { 'content-type': 'application/octet-stream' }
			: o.body !== undefined
				? { 'content-type': 'application/json' }
				: {},
		body: o.raw ? new Uint8Array(o.raw) : o.body !== undefined ? JSON.stringify(o.body) : undefined
	});
	const res = await (handler as Handler)({
		request,
		url,
		params: o.params ?? {}
	} as unknown as RequestEvent);
	const type = res.headers.get('content-type') ?? '';
	return {
		status: res.status,
		headers: res.headers,
		body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer())
	};
}

describe('system presets over the API', () => {
	it('gives an overview: where the presets come from and which models they cover', async () => {
		const r = await call(profilesRoute.GET);
		const o = r.body as ProfilesOverview;
		expect(o.vendor).toMatchObject({ version: '01.00.00.01', source: 'env', dir: FIXTURE });
		expect(o.missing).toBe(null);
		expect(o.models.find((m) => m.code === 'BL-P001')?.nozzles).toEqual(['0.2', '0.4']);
		expect(o.models.find((m) => m.code === 'N1')?.nozzles).toEqual(['0.4']);
		expect(o.models.find((m) => m.code === 'N6')?.nozzles).toEqual([]);
	});

	it('lists, resolves and picks defaults', async () => {
		const list = await call(profilesRoute.GET, {
			url: `/api/slicer/profiles?kind=process&printer=${encodeURIComponent(A1M)}`
		});
		expect(list.body.map((p: { name: string }) => p.name)).toEqual([
			'0.20mm Standard @BBL A1M',
			'0.16mm Mini only @Test'
		]);
		expect((await call(profilesRoute.GET, { url: '/api/slicer/profiles?kind=nope' })).status).toBe(
			400
		);
		const d = await call(detailRoute.GET, {
			url: `/api/slicer/profiles/preset?kind=printer&name=${encodeURIComponent(A1M)}`
		});
		const detail = d.body as PresetDetail;
		expect(detail.preset.config.printable_height).toBe('180');
		expect(detail.summary?.nozzle).toBe('0.4');
		expect(detail.pages.map((p) => p.page)).toContain('Other');
		const defaults = await call(defaultsRoute.GET, {
			url: '/api/slicer/profiles/defaults?model=N1'
		});
		expect(defaults.body.process.name).toBe('0.20mm Standard @BBL A1M');
		const bundle = await call(bundleRoute.POST, {
			method: 'POST',
			body: { selection: defaults.body }
		});
		expect(bundle.body.full.printer_settings_id).toBe(A1M);
		expect(bundle.body).not.toHaveProperty('workspace');
	});

	it('finds the preset for what the simulated printer’s tray holds (tray_info_idx GFA00)', async () => {
		const { info } = t.printer('N1');
		const snap = t.rt.printers.statuses().find((p) => p.id === info.id)!.state!;
		const trays = [...snap.ams.flatMap((u) => u.trays), ...snap.externalSpools];
		const pla = trays.find((x) => x.infoIdx === 'GFA00')!;
		const r = await call(trayRoute.GET, {
			url: `/api/slicer/profiles/tray?printer=${info.id}&tray=${pla.global}`
		});
		expect(r.body.preset).toMatchObject({ name: 'Bambu PLA Basic @BBL A1M', filamentId: 'GFA00' });
		const other = trays.find((x) => x.infoIdx && x.infoIdx !== 'GFA00')!;
		const none = await call(trayRoute.GET, {
			url: `/api/slicer/profiles/tray?printer=${info.id}&tray=${other.global}`
		});
		expect(none.body.preset).toBe(null);
	});
});

let strong: UserPreset & { version: number };

describe('user presets over the API', () => {
	it('creates a preset from a system preset, storing only its changes', async () => {
		const r = await call(presetsRoute.POST, {
			method: 'POST',
			body: {
				kind: 'process',
				name: 'Strong A1M',
				from: { kind: 'process', name: '0.20mm Standard @BBL A1M', source: 'system' },
				config: { sparse_infill_density: '40%', wall_loops: '3' }
			}
		});
		expect(r.status).toBe(200);
		strong = r.body.preset;
		expect(strong).toMatchObject({
			inherits: '0.20mm Standard @BBL A1M',
			config: { sparse_infill_density: '40%' },
			version: 1
		});
		const dupe = await call(presetsRoute.POST, {
			method: 'POST',
			body: { kind: 'process', name: 'Strong A1M', from: null }
		});
		expect(dupe.status).toBe(409);
		const bad = await call(presetsRoute.POST, {
			method: 'POST',
			body: { kind: 'process', name: 'x/y', config: { 'Bad Key': '1' } }
		});
		expect(bad.status).toBe(400);
	});

	it('edits with the version it read, and shows the diff against the parent', async () => {
		const r = await call(presetRoute.PATCH, {
			method: 'PATCH',
			params: { id: strong.id },
			body: { version: 1, config: { sparse_infill_density: '35%', layer_height: '0.2' } }
		});
		expect(r.body.preset).toMatchObject({ version: 2, config: { sparse_infill_density: '35%' } });
		const stale = await call(presetRoute.PATCH, {
			method: 'PATCH',
			params: { id: strong.id },
			body: { version: 1, name: 'Late' }
		});
		expect(stale.status).toBe(409);
		const d = (await call(presetRoute.GET, { params: { id: strong.id } })).body as PresetDetail;
		const keys = d.pages.flatMap((p) => p.groups.flatMap((g) => g.keys)).filter((k) => k.changed);
		expect(keys).toEqual([
			expect.objectContaining({ key: 'sparse_infill_density', value: '35%', parent: '15%' })
		]);
	});

	it('exports Bambu Studio’s user preset .json and imports it back', async () => {
		const r = await call(exportRoute.GET, { params: { id: strong.id }, url: '/x' });
		expect(r.headers.get('content-disposition')).toMatch(/Strong%20A1M\.json/);
		const json = r.body as Record<string, unknown>;
		expect(json).toMatchObject({
			name: 'Strong A1M',
			from: 'User',
			inherits: '0.20mm Standard @BBL A1M',
			print_settings_id: 'Strong A1M',
			sparse_infill_density: '35%',
			version: '01.00.00.01' // the fixture's own version: its tag is unknown
		});
		// Import it under another name; importing the same name replaces.
		const renamed = Buffer.from(JSON.stringify({ ...json, name: 'Strong copy' }));
		const imp = await call(importRoute.POST, {
			method: 'POST',
			raw: renamed,
			url: '/x?name=a.json'
		});
		expect(imp.body.imported).toEqual([
			expect.objectContaining({ kind: 'process', name: 'Strong copy', replaced: false })
		]);
		const copy = s.store.byName('process', 'Strong copy')!;
		expect(copy.config).toEqual({ sparse_infill_density: '35%' });
		expect(copy.inherits).toBe('0.20mm Standard @BBL A1M');
		const again = await call(importRoute.POST, { method: 'POST', raw: renamed, url: '/x' });
		expect(again.body.imported[0].replaced).toBe(true);
	});

	it('skips what Bambu Studio would skip', async () => {
		const docs = [
			{ name: 'No version', print_settings_id: 'x' },
			{ name: 'No kind', version: '1.0.0' },
			{ name: '0.20mm Standard @BBL A1M', version: '1.0.0', print_settings_id: 'x' },
			{ name: 'Lost parent', version: '1.0.0', inherits: 'Gone', print_settings_id: 'x' }
		];
		const reasons = [];
		for (const d of docs) {
			const r = await call(importRoute.POST, {
				method: 'POST',
				raw: Buffer.from(JSON.stringify(d))
			});
			reasons.push(r.body.skipped[0]?.reason);
		}
		expect(reasons).toEqual([
			'It has no version.',
			'Not a printer, process or filament preset.',
			'A system preset has that name.',
			'It is based on “Gone”, which these Bambu Studio presets do not have.'
		]);
		const junk = await call(importRoute.POST, { method: 'POST', raw: Buffer.from('not json') });
		expect(junk.status).toBe(400);
	});

	it('round-trips a printer bundle (.bbscfg) with the presets that suit the printer', async () => {
		const printer = (
			await call(presetsRoute.POST, {
				method: 'POST',
				body: {
					kind: 'printer',
					name: 'My A1 mini',
					from: { kind: 'printer', name: A1M, source: 'system' },
					config: { printable_height: '175' }
				}
			})
		).body.preset as UserPreset;
		const r = await call(exportRoute.GET, { params: { id: printer.id }, url: '/x?bundle=1' });
		expect(r.headers.get('content-disposition')).toMatch(/My%20A1%20mini\.bbscfg/);
		const files = readZip(r.body as Buffer, () => 'all');
		const structure = JSON.parse(files.get('bundle_structure.json')!.toString());
		expect(structure).toMatchObject({
			bundle_type: 'printer config bundle',
			printer_preset_name: 'My A1 mini',
			printer_config: ['printer/My A1 mini.json'],
			process_config: expect.arrayContaining(['process/Strong A1M.json'])
		});
		expect(JSON.parse(files.get('printer/My A1 mini.json')!.toString())).toMatchObject({
			printer_settings_id: 'My A1 mini',
			printable_height: '175'
		});
		// Remove them and bring them back from the bundle.
		await call(presetRoute.DELETE, { method: 'DELETE', params: { id: printer.id } });
		await call(presetRoute.DELETE, { method: 'DELETE', params: { id: strong.id } });
		const imp = await call(importRoute.POST, {
			method: 'POST',
			raw: r.body as Buffer,
			url: '/x?name=b.bbscfg'
		});
		expect(imp.body.imported.map((i: { name: string }) => i.name).sort()).toEqual(
			expect.arrayContaining(['My A1 mini', 'Strong A1M'])
		);
		expect(s.store.byName('printer', 'My A1 mini')?.config).toEqual({ printable_height: '175' });
		strong = s.store.byName('process', 'Strong A1M')!;
	});

	it('exports a filament bundle (.bbsflmt) by filament name and vendor', async () => {
		const f = s.createUser({
			kind: 'filament',
			name: 'Bambu PLA Basic @My A1M',
			from: { kind: 'filament', name: 'Bambu PLA Basic @BBL A1M', source: 'system' },
			config: { nozzle_temperature: ['215'] }
		});
		const file = s.exportUser(f.id, true);
		expect(file.name).toBe('Bambu PLA Basic.bbsflmt');
		const files = readZip(file.data, () => 'all');
		expect(JSON.parse(files.get('bundle_structure.json')!.toString())).toMatchObject({
			bundle_type: 'filament config bundle',
			filament_name: 'Bambu PLA Basic',
			filament_vendor: [
				{ vendor: 'Bambu Lab', filament_path: ['Bambu Lab/Bambu PLA Basic @My A1M.json'] }
			]
		});
		expect(
			JSON.parse(files.get('Bambu Lab/Bambu PLA Basic @My A1M.json')!.toString())
		).toMatchObject({
			filament_settings_id: ['Bambu PLA Basic @My A1M'],
			nozzle_temperature: ['215']
		});
	});
});

describe('a job’s slicer settings', () => {
	let jobId: string;
	let spoolId: string;

	beforeAll(() => {
		const lab = t.rt.lab;
		const profileId = lab.createProfile({ name: 'Sam', color: 'blue' }) as unknown as string;
		const projectId = lab.createProject({ profileId, title: 'Bracket' }) as unknown as string;
		spoolId = lab.createSpool({
			material: 'PLA',
			colorHex: '#ff8800',
			totalGrams: 1000,
			remainingGrams: 800
		}) as unknown as string;
		jobId = lab.createJob({
			projectId,
			printerId: t.printer('N1').info.id,
			spoolId,
			infill: 25,
			supports: 'Tree',
			layerHeight: '0.16'
		}) as unknown as string;
	});

	it('defaults from the job’s printer, layer height, material and fields', () => {
		const j = s.forJob(jobId);
		expect(j.selection).toEqual({
			printer: { kind: 'printer', name: A1M, source: 'system' },
			process: { kind: 'process', name: '0.16mm Mini only @Test', source: 'system' },
			filaments: [{ kind: 'filament', name: 'Bambu PLA Basic @BBL A1M', source: 'system' }]
		});
		expect(j.overrides.process).toEqual({
			sparse_infill_density: '25%',
			enable_support: '1',
			support_type: 'tree(auto)'
		});
		expect(j.overrides.filaments).toEqual([{ filament_colour: ['#FF8800'] }]);
	});

	it('uses the spool’s filament preset', async () => {
		const set = await call(spoolRoute.PUT, {
			method: 'PUT',
			params: { id: spoolId },
			body: { preset: { kind: 'filament', name: 'Generic PLA', source: 'system' } }
		});
		expect(set.body.preset.name).toBe('Generic PLA');
		expect(set.body.workspace.spools[0].filamentPreset.name).toBe('Generic PLA');
		expect(s.forJob(jobId).selection.filaments[0].name).toBe('Generic PLA');
		// A preset for another printer becomes the same Bambu filament for the job's printer.
		s.setSpoolPreset(spoolId, {
			preset: { kind: 'filament', name: 'Bambu PLA Basic @BBL X1C', source: 'system' }
		});
		expect(s.forJob(jobId).selection.filaments[0].name).toBe('Bambu PLA Basic @BBL A1M');
		const wrong = await call(spoolRoute.PUT, {
			method: 'PUT',
			params: { id: spoolId },
			body: { preset: { kind: 'process', name: '0.20mm Standard @BBL A1M', source: 'system' } }
		});
		expect(wrong.status).toBe(400);
	});

	it('takes the job’s own presets and key overrides, and flows them into the combined config', async () => {
		const r = await call(jobRoute.PUT, {
			method: 'PUT',
			params: { id: jobId },
			body: {
				process: { kind: 'process', name: 'Strong A1M', source: 'user', userPresetId: strong.id },
				overrides: { process: { wall_loops: '6', sparse_infill_density: '50%' } }
			}
		});
		expect(r.status).toBe(200);
		const view = r.body.view as JobSliceView;
		expect(view.selection?.process.name).toBe('Strong A1M');
		expect(view.processes.map((p) => p.name)).toContain('Strong A1M');
		const b = t.rt.module('slicer-profiles')!.bundleForJob(jobId);
		expect(b.full.wall_loops).toBe('6');
		expect(b.full.sparse_infill_density).toBe('50%'); // the job's override beats its infill field
		expect(b.full.support_type).toBe('tree(auto)');
		expect(b.full.print_settings_id).toBe('Strong A1M');
		expect(b.full.different_settings_to_system?.[0]).toBe(
			'enable_support;sparse_infill_density;support_type;wall_loops'
		);
		// A deleted user preset falls back to the default.
		const temp = s.createUser({
			kind: 'process',
			name: 'Short-lived',
			from: { kind: 'process', name: '0.20mm Standard @BBL A1M', source: 'system' }
		});
		s.setJobSettings(jobId, {
			process: { kind: 'process', name: 'Short-lived', source: 'user', userPresetId: temp.id }
		});
		s.removeUser(temp.id);
		expect(s.forJob(jobId).selection.process.name).toBe('0.16mm Mini only @Test');
		// Clearing everything stores nothing.
		await call(jobRoute.PUT, { method: 'PUT', params: { id: jobId }, body: {} });
		expect(s.jobSettings(jobId)).toEqual({});
		const bad = await call(jobRoute.PUT, {
			method: 'PUT',
			params: { id: jobId },
			body: { process: { kind: 'process', name: 'Nope', source: 'system' } }
		});
		expect(bad.status).toBe(404);
	});

	it('shows why presets are unavailable instead of failing', async () => {
		const lab = t.rt.lab;
		const projectId = lab.snapshot().projects[0].id;
		const other = lab.createJob({ projectId, nozzle: '0.8' }) as unknown as string;
		const r = await call(jobRoute.GET, { params: { id: other } });
		expect(r.body.error).toMatch(/0.8 mm nozzle/);
	});
});
