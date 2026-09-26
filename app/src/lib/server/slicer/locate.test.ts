import { describe, expect, it } from 'vitest';
import { locateCli, locateEngine, locateSlicers, type SlicerHost } from './locate';

/** A fake machine: `files` are executable unless listed in `plain`. */
function host(files: string[], o: Partial<SlicerHost> & { plain?: string[] } = {}): SlicerHost {
	const set = new Set(files);
	const dirs = new Set<string>();
	for (const f of files) {
		let d = f;
		while ((d = d.replace(/[/\\][^/\\]*$/, '')) && !dirs.has(d)) dirs.add(d);
	}
	return {
		platform: 'linux',
		arch: 'x64',
		home: '/home/u',
		isFile: (p) => set.has(p),
		isExecutable: (p) => !o.plain?.includes(p),
		isDir: (p) => dirs.has(p),
		readdir: (p) =>
			[...dirs, ...set]
				.filter((x) => x.startsWith(`${p}/`) && !x.slice(p.length + 1).includes('/'))
				.map((x) => x.slice(p.length + 1)),
		...o
	};
}

describe('locating the slicer', () => {
	it('prefers the explicit engine, then the desktop bundle, then dev builds, then stock CLIs', () => {
		const h = host([
			'/opt/eng/printlab-slicer',
			'/opt/eng/resources/profiles/BBL.json',
			'/app/server/engine/printlab-slicer',
			'/app/server/engine/resources/x',
			'/repo/slicer/upstream.lock',
			'/repo/slicer/dist/linux-x64/printlab-slicer',
			'/build/engine/printlab-slicer',
			'/home/u/.local/opt/bambu-studio-02.08.02.61/AppRun',
			'/home/u/.local/opt/bambu-studio-02.10.00.10/AppRun',
			'/home/u/.local/opt/bambu-studio-02.10.00.10/resources/profiles/BBL.json',
			'/home/u/.local/opt/orca-slicer-2.3.1/AppRun',
			'/usr/bin/bambu-studio'
		]);
		const env = {
			PRINTLAB_SLICER_PATH: '/opt/eng/printlab-slicer',
			PRINTLAB_SLICER_BUILD_DIR: '/build'
		};
		const all = locateSlicers(env, '/app/server', h);
		expect(all.map((l) => [l.source, l.kind, l.path])).toEqual([
			['env', 'engine', '/opt/eng/printlab-slicer'],
			['desktop', 'engine', '/app/server/engine/printlab-slicer'],
			['dev-build', 'engine', '/build/engine/printlab-slicer'],
			['installed', 'bambu-studio-cli', '/home/u/.local/opt/bambu-studio-02.10.00.10/AppRun'],
			['installed', 'bambu-studio-cli', '/home/u/.local/opt/bambu-studio-02.08.02.61/AppRun'],
			['installed', 'orca-slicer-cli', '/home/u/.local/opt/orca-slicer-2.3.1/AppRun'],
			['installed', 'bambu-studio-cli', '/usr/bin/bambu-studio']
		]);
		expect(all[0].resourcesDir).toBe('/opt/eng/resources');
		expect(all[3].resourcesDir).toBe('/home/u/.local/opt/bambu-studio-02.10.00.10/resources');
		// The repo's dev build is found by walking up from a working directory inside it.
		expect(locateEngine({}, '/repo/app', h)).toMatchObject({
			source: 'dev-build',
			path: '/repo/slicer/dist/linux-x64/printlab-slicer'
		});
		expect(locateCli({ BAMBU_STUDIO_PATH: '/usr/bin/bambu-studio' }, '/x', h)).toMatchObject({
			kind: 'bambu-studio-cli',
			source: 'env'
		});
	});

	it('skips files that are not executable, and knows macOS and Windows layouts', () => {
		const h = host(['/app/engine/printlab-slicer'], { plain: ['/app/engine/printlab-slicer'] });
		expect(locateEngine({}, '/app', h)).toBeNull();
		const mac = host(
			[
				'/Applications/BambuStudio.app/Contents/MacOS/BambuStudio',
				'/Applications/BambuStudio.app/Contents/Resources/profiles/BBL.json'
			],
			{ platform: 'darwin', arch: 'arm64' }
		);
		expect(locateCli({}, '/x', mac)).toMatchObject({
			resourcesDir: '/Applications/BambuStudio.app/Contents/Resources'
		});
		const win = host(['C:\\Program Files\\Bambu Studio\\bambu-studio.exe'], {
			platform: 'win32',
			isFile: (p) => p === 'C:\\Program Files\\Bambu Studio\\bambu-studio.exe',
			isDir: () => false
		});
		expect(locateCli({ ProgramFiles: 'C:\\Program Files' }, 'C:\\app', win)).toMatchObject({
			kind: 'bambu-studio-cli',
			path: 'C:\\Program Files\\Bambu Studio\\bambu-studio.exe'
		});
		expect(locateSlicers({}, '/nowhere', host([]))).toEqual([]);
	});
});
