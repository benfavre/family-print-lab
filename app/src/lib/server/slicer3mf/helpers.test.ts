import { describe, expect, it } from 'vitest';
import {
	parseXml,
	rootElement,
	decodeEntities,
	escapeXml,
	xmlUnescape,
	xmlFragmentElements
} from './xml';
import { formatG9, formatNumber, scanMesh, sliceTriangles } from './mesh';
import { composeTransforms, formatTransform, parseTransform } from './transform';
import { parsePrintLabFile, printLabFile } from './printlab-file';
import { read3mf } from './read';
import { write3mf } from './write';
import { readZip, writeZip } from '../cad/mesh';
import { addObject, arrange, isArchiveName } from './store';
import { emptyProject, type MeshRef, type Transform } from '$lib/shared/slicer/project';

describe('xml', () => {
	it('parses elements, attributes, text and offsets', () => {
		const src =
			'<?xml version="1.0"?><!-- c --><a x="1" y=\'2 &amp; 3\'><b/>t&lt;<c k="v&#10;w">in</c></a>';
		const a = rootElement(parseXml(src));
		expect(a.name).toBe('a');
		expect(a.attrs).toEqual({ x: '1', y: '2 & 3' });
		expect(a.children.map((c) => c.name)).toEqual(['b', 'c']);
		expect(a.text).toBe('t<');
		expect(a.children[1].attrs.k).toBe('v\nw');
		expect(src.slice(a.children[1].start, a.children[1].end)).toBe('<c k="v&#10;w">in</c>');
		expect(src.slice(a.children[1].innerStart, a.children[1].innerEnd)).toBe('in');
	});

	it('keeps newlines in attributes and skips raw elements', () => {
		const src = '<m><mesh><vertex x="1"/></mesh><e v="a\nb"/></m>';
		const m = rootElement(parseXml(src, new Set(['mesh'])));
		expect(m.children[0].children).toEqual([]);
		expect(src.slice(m.children[0].innerStart, m.children[0].innerEnd)).toBe('<vertex x="1"/>');
		expect(m.children[1].attrs.v).toBe('a\nb');
	});

	it('escapes like upstream and unescapes like upstream', () => {
		expect(escapeXml(`a<b>&"'`)).toBe('a&lt;b&gt;&amp;&quot;&apos;');
		expect(decodeEntities('&#x41;&#66;&quot;&bogus;')).toBe('AB"&bogus;');
		// utils.cpp xml_unescape only knows &lt; &gt; &amp;.
		expect(xmlUnescape('&amp;lt; &quot;')).toBe('&lt; &quot;');
	});
});

describe('verbatim XML and archive names', () => {
	it('counts top-level elements of well-formed fragments', () => {
		expect(xmlFragmentElements('<mesh_stat face_count="12" edges_fixed="0"/>')).toBe(1);
		expect(xmlFragmentElements('<assemble>\n <item a="1&amp;2"/>\n</assemble>')).toBe(1);
		expect(xmlFragmentElements('\n  <cut_id id="3"/>\n  <connectors><c/></connectors>\n ')).toBe(2);
		expect(xmlFragmentElements('<a><![CDATA[x < y]]><!-- c --></a>')).toBe(1);
		expect(xmlFragmentElements('')).toBe(0);
	});

	it('refuses XML that would break the file it is pasted into', () => {
		for (const bad of [
			'</object><evil/>',
			'<a>',
			'<a></b>',
			'<a x=1/>',
			'<a x="1"y="2"/>',
			'text<a/>',
			'<a>&nope</a>',
			'<a b="<"/>',
			'<1a/>',
			'<a/><!-- open'
		])
			expect(xmlFragmentElements(bad), bad).toBe(-1);
	});

	it('only accepts relative archive paths', () => {
		expect(isArchiveName('Metadata/plate_1.png')).toBe(true);
		expect(isArchiveName('[Content_Types].xml')).toBe(true);
		for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', 'a\\b', './a', 'a/', 'a\0b'])
			expect(isArchiveName(bad), bad).toBe(false);
	});
});

describe('numbers and transforms', () => {
	it('formats coordinates like sprintf("%.9g")', () => {
		expect(formatG9(0)).toBe('0');
		expect(formatG9(1)).toBe('1');
		expect(formatG9(0.3)).toBe('0.300000012');
		expect(formatG9(-12.5)).toBe('-12.5');
		expect(formatG9(123456789)).toBe('123456792');
		expect(formatG9(1e-10)).toBe('1.00000001e-10');
		expect(formatG9(3e12)).toBe('3.00000005e+12');
		// Every float32 survives.
		for (const f of [0.1, 1 / 3, 255.999, -0.000123]) {
			const v = Math.fround(f);
			expect(Math.fround(Number(formatG9(v)))).toBe(v);
		}
	});

	it('writes doubles exactly, including -0', () => {
		expect(formatNumber(0.1 + 0.2)).toBe('0.30000000000000004');
		expect(formatNumber(-0)).toBe('-0');
		expect(Object.is(Number(formatNumber(-0)), -0)).toBe(true);
	});

	it('parses, formats and composes 3MF transforms (row vectors)', () => {
		expect(parseTransform('1 0 0 0 1 0 0 0 1 5 6 7')).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 6, 7]);
		expect(parseTransform('1 2 3')).toBeNull();
		expect(parseTransform('1 0 0 0 1 0 0 0 1 x 0 0')).toBeNull();
		const scale: Transform = [2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0];
		const move: Transform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 0, 0];
		// Scale then move: the translation is not scaled.
		expect(composeTransforms(scale, move)).toEqual([2, 0, 0, 0, 2, 0, 0, 0, 2, 10, 0, 0]);
		// Move then scale: it is.
		expect(composeTransforms(move, scale)).toEqual([2, 0, 0, 0, 2, 0, 0, 0, 2, 20, 0, 0]);
		expect(formatTransform(move)).toBe('1 0 0 0 1 0 0 0 1 10 0 0');
	});
});

describe('mesh scanning', () => {
	it('reads vertices, triangles and painting', () => {
		const s = scanMesh(
			'<vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/></vertices>' +
				'<triangles><triangle v1="0" v2="2" v3="1" paint_color="8"/><triangle v1="0" v2="1" v3="3" slic3rpe:custom_supports="4" face_property="x"/></triangles>'
		);
		expect(Array.from(s.triangles)).toEqual([0, 2, 1, 0, 1, 3]);
		expect(s.paint).toEqual({ color: { 0: '8' }, supports: { 1: '4' } });
		expect(s.faceProperties).toEqual({ 1: 'x' });
		const part = sliceTriangles(s, 1, 1);
		expect(Array.from(part.triangles)).toEqual([0, 1, 2]);
		expect(Array.from(part.vertices)).toEqual([0, 0, 0, 1, 0, 0, 0, 0, 1]);
	});

	it('refuses bad indices and coordinates', () => {
		expect(() => scanMesh('<vertex x="0" y="0" z="0"/><triangle v1="0" v2="1" v3="2"/>')).toThrow(
			/does not exist/
		);
		expect(() => scanMesh('<vertex x="a" y="0" z="0"/>')).toThrow(/bad coordinate/);
	});
});

describe('Metadata/print_lab.json', () => {
	const presets = {
		printer: {
			kind: 'printer' as const,
			name: 'Bambu Lab H2D 0.4 nozzle',
			source: 'system' as const
		},
		process: {
			kind: 'process' as const,
			name: '0.20mm Standard @BBL H2D',
			source: 'project' as const
		},
		filaments: [
			{
				kind: 'filament' as const,
				name: 'My PLA',
				source: 'user' as const,
				userPresetId: 'u1'
			}
		]
	};

	it('is left out when the 3MF says everything', () => {
		const p = emptyProject({
			...presets,
			printer: { ...presets.printer, source: 'project' },
			filaments: []
		});
		expect(printLabFile(p)).toBeNull();
	});

	it('carries trays, spools, nozzles and preset sources through a save', () => {
		const p = emptyProject(presets);
		p.filaments[0] = { ...p.filaments[0], color: '#FF0000', tray: 2, spoolId: 's1', nozzle: 1 };
		const mesh: MeshRef = {
			id: 'a'.repeat(64),
			triangles: 1,
			vertices: 3,
			bbox: [0, 0, 0, 1, 1, 0],
			storage: { kind: 'file', path: 'x.stl' }
		};
		addObject(p, 'Tri', mesh);
		arrange(p);
		const buf = write3mf(p, {
			mesh: () => ({
				vertices: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
				triangles: Uint32Array.from([0, 1, 2])
			})
		});
		const files = readZip(buf, () => 'all');
		expect(parsePrintLabFile(files.get('Metadata/print_lab.json')!.toString())).toBeTruthy();
		const settings = JSON.parse(files.get('Metadata/project_settings.config')!.toString());
		expect(settings).toMatchObject({
			printer_settings_id: 'Bambu Lab H2D 0.4 nozzle',
			filament_settings_id: ['My PLA'],
			filament_colour: ['#FF0000'],
			filament_type: ['PLA']
		});
		const back = read3mf(buf).project;
		expect(back.presets).toEqual(presets);
		expect(back.filaments[0]).toEqual({
			index: 1,
			preset: presets.filaments[0],
			color: '#FF0000',
			type: 'PLA',
			tray: 2,
			spoolId: 's1',
			nozzle: 1
		});
		expect(back.objects[0].instances[0].transform.slice(9)).toEqual([127.5, 127.5, 0]);
	});

	it('ignores a file that is not ours or names other presets', () => {
		expect(parsePrintLabFile('{"format":2}')).toBeNull();
		expect(parsePrintLabFile('nope')).toBeNull();
	});
});

describe('broken files', () => {
	it('answers plain errors instead of crashing', async () => {
		const { writeZip } = await import('../cad/mesh');
		const zip = (files: [string, string][]) =>
			writeZip(files.map(([n, t]) => [n, Buffer.from(t)] as [string, Buffer]));
		expect(() => read3mf(zip([['a.txt', 'x']]))).toThrow('no 3D model');
		expect(() =>
			read3mf(zip([['3D/3dmodel.model', '<model><resources><object id="1"><mesh>']]))
		).toThrow(/could not be read/);
		expect(() =>
			read3mf(zip([['3D/3dmodel.model', '<model><resources/><build/></model>']]))
		).toThrow('nothing on its build plate');
		expect(() =>
			read3mf(
				zip([
					[
						'3D/3dmodel.model',
						'<model><resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>'
					]
				])
			)
		).toThrow(/does not exist/);
	});

	it('refuses archives that unpack to more than the cap', () => {
		const bomb = writeZip([
			['3D/3dmodel.model', Buffer.alloc(2_000_000, 32)],
			['Metadata/big.bin', Buffer.alloc(2_000_000)]
		]);
		expect(bomb.length).toBeLessThan(20_000);
		expect(() => readZip(bomb, () => 'all', 3_000_000)).toThrow('unpacks to more');
		expect(readZip(bomb, () => 'all', 4_000_000).size).toBe(2);
		expect(() => read3mf(bomb, { maxUnpackedBytes: 1_000_000 })).toThrow('unpacks to more');
	});

	it('renumbers plates without a usable number and lists an instance once', () => {
		const model =
			'<model><resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>';
		const inst =
			'<model_instance><metadata key="object_id" value="1"/><metadata key="instance_id" value="0"/></model_instance>';
		const settings = `<config><plate><metadata key="plater_id" value="1"/>${inst}${inst}</plate><plate><metadata key="plater_id" value="1"/></plate><plate></plate></config>`;
		const { project, warnings } = read3mf(
			writeZip([
				['3D/3dmodel.model', Buffer.from(model)],
				['Metadata/model_settings.config', Buffer.from(settings)]
			])
		);
		expect(project.plates.map((p) => p.index)).toEqual([1, 2, 3]);
		expect(project.plates[0].instances).toEqual([{ objectId: 'o1', instanceId: 'o1-i1' }]);
		expect(warnings.filter((w) => w.includes('renumbered'))).toHaveLength(2);
	});
});
