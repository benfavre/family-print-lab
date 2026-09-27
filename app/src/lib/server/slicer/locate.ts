// Where the slicer is: our engine (printlab-slicer, from slicer/ in this repository) or, as a
// fallback backend, a stock Bambu Studio / OrcaSlicer install driven through its command line.
// Search order (the first existing, executable file of each kind wins):
//   1. PRINTLAB_SLICER_PATH (the engine binary; resources in a sibling resources/)          env
//   2. <cwd>/engine/printlab-slicer (the desktop app runs the server with cwd = desktop/server) desktop
//   3. <repo>/slicer/dist/<plat>/printlab-slicer, then $PRINTLAB_SLICER_BUILD_DIR/engine/…      dev-build
//   4. BAMBU_STUDIO_PATH, ORCA_SLICER_PATH (env), then the usual install places                installed
// None found: slicing is unavailable and Integrations explains how to get it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface SlicerLocation {
	kind: 'engine' | 'bambu-studio-cli' | 'orca-slicer-cli';
	path: string;
	/** Profiles live at <resourcesDir>/profiles/BBL(.json). */
	resourcesDir: string | null;
	source: 'env' | 'desktop' | 'dev-build' | 'installed';
}

/** The machine to look at (tests pass a fake one). */
export interface SlicerHost {
	platform: NodeJS.Platform;
	arch: string;
	home: string;
	isFile(p: string): boolean;
	isExecutable(p: string): boolean;
	isDir(p: string): boolean;
	readdir(p: string): string[];
}

const realHost = (): SlicerHost => ({
	platform: process.platform,
	arch: process.arch,
	home: os.homedir(),
	isFile: (p) => {
		try {
			return fs.statSync(p).isFile();
		} catch {
			return false;
		}
	},
	isExecutable: (p) => {
		if (process.platform === 'win32') return true;
		try {
			fs.accessSync(p, fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	},
	isDir: (p) => {
		try {
			return fs.statSync(p).isDirectory();
		} catch {
			return false;
		}
	},
	readdir: (p) => {
		try {
			return fs.readdirSync(p);
		} catch {
			return [];
		}
	}
});

/** "linux-x64", "darwin-arm64", "darwin-x64", "win32-x64". */
export const platformKey = (h: Pick<SlicerHost, 'platform' | 'arch'>) => `${h.platform}-${h.arch}`;

/**
 * Walks up from `cwd` to the repository root (it has slicer/UPSTREAM.md, or at least slicer/upstream.lock).
 * app/tools/lib/upstream.ts has its own repoRoot: tools/ is build-time only and never bundled into the
 * server, and this one takes a fake host for tests.
 */
export function findRepo(cwd: string, host: SlicerHost = realHost()): string | null {
	const p = host.platform === 'win32' ? path.win32 : path.posix;
	let dir = p.resolve(cwd);
	for (;;) {
		if (
			host.isFile(p.join(dir, 'slicer', 'UPSTREAM.md')) ||
			host.isFile(p.join(dir, 'slicer', 'upstream.lock'))
		)
			return dir;
		const parent = p.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

export function locateSlicers(
	env: Record<string, string | undefined> = process.env,
	cwd = process.cwd(),
	host: SlicerHost = realHost()
): SlicerLocation[] {
	const p = host.platform === 'win32' ? path.win32 : path.posix;
	const exe = host.platform === 'win32' ? '.exe' : '';
	const usable = (file: string) => host.isFile(file) && host.isExecutable(file);
	const dirIf = (dir: string) => (host.isDir(dir) ? dir : null);
	const out: SlicerLocation[] = [];
	const add = (loc: SlicerLocation) => {
		if (usable(loc.path) && !out.some((o) => o.path === loc.path)) out.push(loc);
	};

	// 1–3: our engine.
	if (env.PRINTLAB_SLICER_PATH)
		add({
			kind: 'engine',
			path: env.PRINTLAB_SLICER_PATH,
			resourcesDir: dirIf(p.join(p.dirname(env.PRINTLAB_SLICER_PATH), 'resources')),
			source: 'env'
		});
	add({
		kind: 'engine',
		path: p.join(cwd, 'engine', `printlab-slicer${exe}`),
		resourcesDir: dirIf(p.join(cwd, 'engine', 'resources')),
		source: 'desktop'
	});
	const repo = findRepo(cwd, host);
	if (repo) {
		const dist = p.join(repo, 'slicer', 'dist', platformKey(host));
		add({
			kind: 'engine',
			path: p.join(dist, `printlab-slicer${exe}`),
			resourcesDir: dirIf(p.join(dist, 'resources')),
			source: 'dev-build'
		});
	}
	if (env.PRINTLAB_SLICER_BUILD_DIR) {
		const engine = p.join(env.PRINTLAB_SLICER_BUILD_DIR, 'engine');
		add({
			kind: 'engine',
			path: p.join(engine, `printlab-slicer${exe}`),
			resourcesDir:
				dirIf(p.join(engine, 'resources')) ??
				(repo ? dirIf(p.join(repo, 'slicer', '.upstream', 'resources')) : null),
			source: 'dev-build'
		});
	}

	// 4: stock command lines, the fallback backend.
	const cli = (kind: SlicerLocation['kind'], file: string, source: SlicerLocation['source']) => {
		// Linux AppImage and Windows: <dir>/resources; macOS bundle: Contents/Resources.
		const mac = file.match(/^(.*\.app)\/Contents\/MacOS\//);
		const resources = mac
			? p.join(mac[1], 'Contents', 'Resources')
			: p.join(p.dirname(file), 'resources');
		add({ kind, path: file, resourcesDir: dirIf(resources), source });
	};
	if (env.BAMBU_STUDIO_PATH) cli('bambu-studio-cli', env.BAMBU_STUDIO_PATH, 'env');
	if (env.ORCA_SLICER_PATH) cli('orca-slicer-cli', env.ORCA_SLICER_PATH, 'env');
	const opt = p.join(host.home, '.local', 'opt');
	const newest = (prefix: RegExp) =>
		host
			.readdir(opt)
			.filter((d) => prefix.test(d))
			.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
	for (const d of newest(/^bambu-studio-\d/))
		cli('bambu-studio-cli', p.join(opt, d, 'AppRun'), 'installed');
	for (const d of newest(/^orca-slicer-\d/))
		cli('orca-slicer-cli', p.join(opt, d, 'AppRun'), 'installed');
	if (host.platform === 'darwin') {
		cli(
			'bambu-studio-cli',
			'/Applications/BambuStudio.app/Contents/MacOS/BambuStudio',
			'installed'
		);
		cli('orca-slicer-cli', '/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer', 'installed');
	}
	if (host.platform === 'win32') {
		const programs = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files';
		cli('bambu-studio-cli', p.join(programs, 'Bambu Studio', 'bambu-studio.exe'), 'installed');
		cli('orca-slicer-cli', p.join(programs, 'OrcaSlicer', 'orca-slicer.exe'), 'installed');
	}
	if (host.platform === 'linux') {
		cli('bambu-studio-cli', '/usr/bin/bambu-studio', 'installed');
		cli('orca-slicer-cli', '/usr/bin/orca-slicer', 'installed');
	}
	return out;
}

/** Our engine, if one is found. */
export function locateEngine(
	env?: Record<string, string | undefined>,
	cwd?: string,
	host?: SlicerHost
): SlicerLocation | null {
	return locateSlicers(env, cwd, host).find((l) => l.kind === 'engine') ?? null;
}

/** A stock Bambu Studio or OrcaSlicer command line, if one is found. */
export function locateCli(
	env?: Record<string, string | undefined>,
	cwd?: string,
	host?: SlicerHost
): SlicerLocation | null {
	return locateSlicers(env, cwd, host).find((l) => l.kind !== 'engine') ?? null;
}
