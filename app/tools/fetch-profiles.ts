// Fetches Bambu Studio's system presets (resources/profiles/BBL.json and resources/profiles/BBL/) at
// the tag pinned in slicer/upstream.lock into app/resources/bambu/profiles/ (git-ignored; the desktop
// build copies resources/ as a whole). The server looks for profiles in this order: the engine's
// bundled resources, PRINTLAB_PROFILES_DIR, this folder, then the stock Bambu Studio install.
//   bun run profiles:fetch [--from <bambu studio checkout>] [--allow-unpinned] [--out <dir>]
//   bun run profiles:fetch --groups   (also regenerates src/lib/server/profiles/groups.generated.ts)
// Sources, first that applies: --from (a git checkout is read at the locked commit, never its working
// tree), slicer/.upstream (slicer/scripts/upstream.sh fetch), else a sparse, blob-less clone of just
// the profile folders under slicer/.build/profiles-src (about 15 MB instead of the whole repository).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readUpstreamLock, repoRoot, upstreamFile } from './lib/upstream';

const PATHS = ['resources/profiles/BBL.json', 'resources/profiles/BBL'];

const args = process.argv.slice(2);
const opt = (name: string) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
};
const root = repoRoot(path.dirname(new URL(import.meta.url).pathname));
if (!root) throw new Error('Run this inside the Family Print Lab repository.');
const lock = readUpstreamLock(root);
const out = path.resolve(opt('out') ?? path.join(root, 'app', 'resources', 'bambu', 'profiles'));

const git = (dir: string, gitArgs: string[], input?: Buffer) =>
	execFileSync('git', ['-C', dir, ...gitArgs], {
		input,
		stdio: [input ? 'pipe' : 'ignore', 'pipe', 'inherit'],
		maxBuffer: 512 * 1024 * 1024
	});

function isGit(dir: string) {
	try {
		return git(dir, ['rev-parse', '--show-toplevel']).toString().trim() === fs.realpathSync(dir);
	} catch {
		return false;
	}
}

function hasCommit(dir: string, commit: string) {
	try {
		git(dir, ['cat-file', '-e', `${commit}^{commit}`]);
		return true;
	} catch {
		return false;
	}
}

/** Unpacks the profile folders of `commit` from a checkout into `dest` (BBL.json + BBL/). */
function fromArchive(dir: string, commit: string, dest: string) {
	const tar = git(dir, ['archive', '--format=tar', commit, ...PATHS]);
	execFileSync('tar', ['-x', '--strip-components=2', '-C', dest], {
		input: tar,
		stdio: ['pipe', 'inherit', 'inherit'],
		maxBuffer: 512 * 1024 * 1024
	});
}

/** A sparse clone holding only the profile folders at the locked commit (reused between runs). */
function sparseClone(): string {
	const dir = path.join(root!, 'slicer', '.build', 'profiles-src');
	if (!fs.existsSync(path.join(dir, '.git'))) {
		fs.mkdirSync(dir, { recursive: true });
		git(dir, ['init', '--quiet']);
		git(dir, ['remote', 'add', 'origin', lock.url]);
		git(dir, ['config', 'extensions.partialClone', 'origin']);
		git(dir, ['sparse-checkout', 'set', '--no-cone', ...PATHS.map((p) => `/${p}`)]);
	}
	if (!hasCommit(dir, lock.commit)) {
		console.log(`• downloading the profiles of ${lock.tag} from ${lock.url}`);
		git(dir, ['fetch', '--quiet', '--depth', '1', '--filter=blob:none', 'origin', lock.commit]);
	}
	git(dir, ['checkout', '--quiet', '--force', lock.commit]);
	return dir;
}

function fetchInto(dest: string) {
	const from = opt('from');
	if (from) {
		const dir = path.resolve(from);
		if (isGit(dir)) {
			if (!hasCommit(dir, lock.commit))
				throw new Error(
					`${dir} does not have ${lock.tag} (${lock.commit.slice(0, 12)}): fetch that tag there first.`
				);
			fromArchive(dir, lock.commit, dest);
			return `${dir} at ${lock.tag}`;
		}
		if (!args.includes('--allow-unpinned'))
			throw new Error(
				`${dir} is not a git checkout, so its version cannot be checked against ${lock.tag}. Pass --allow-unpinned to use it anyway.`
			);
		fs.cpSync(path.join(dir, 'resources', 'profiles', 'BBL.json'), path.join(dest, 'BBL.json'));
		fs.cpSync(path.join(dir, 'resources', 'profiles', 'BBL'), path.join(dest, 'BBL'), {
			recursive: true
		});
		console.warn(`Warning: ${dir} is unpinned; the profiles will claim ${lock.tag}.`);
		return `${dir} (unpinned)`;
	}
	const local = path.join(root!, 'slicer', '.upstream');
	if (fs.existsSync(path.join(local, '.git')) && hasCommit(local, lock.commit)) {
		fromArchive(local, lock.commit, dest);
		return `slicer/.upstream at ${lock.tag}`;
	}
	const clone = sparseClone();
	fs.cpSync(path.join(clone, 'resources', 'profiles', 'BBL.json'), path.join(dest, 'BBL.json'));
	fs.cpSync(path.join(clone, 'resources', 'profiles', 'BBL'), path.join(dest, 'BBL'), {
		recursive: true
	});
	return `${lock.url} at ${lock.tag}`;
}

/**
 * Bambu Studio's parameter tabs (src/slic3r/GUI/Tab.cpp: TabPrint, TabFilament, TabPrinter build()):
 * page → option group → keys, so the preset editor groups keys the way Bambu Studio does.
 */
async function writeGroups() {
	const src = (
		await upstreamFile('src/slic3r/GUI/Tab.cpp', {
			root,
			from: opt('from'),
			allowUnpinned: args.includes('--allow-unpinned')
		})
	)
		.toString('utf8')
		// Commented-out option lines are not in the tabs.
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');
	const section = (start: RegExp, end: RegExp) => {
		const from = src.search(start);
		if (from < 0) throw new Error(`Tab.cpp: ${start} not found.`);
		const rest = src.slice(from);
		const to = rest.slice(1).search(end);
		return to < 0 ? rest : rest.slice(0, to + 1);
	};
	const parse = (text: string) => {
		const pages: { page: string; groups: { group: string; keys: string[] }[] }[] = [];
		const seen = new Set<string>();
		const re =
			/add_options_page\(\s*(?:L\("([^"]+)"\)|(page_name))|new_optgroup\(\s*(?:L\("([^"]*)"\)|"([^"]*)")|(?:append_single_option_line|get_option|append_option_line\(\s*optgroup\s*,)\s*\(?\s*"([a-z0-9_]+)"/g;
		for (const m of text.matchAll(re)) {
			// Per-extruder pages are titled at run time ("Extruder 1"…).
			if (m[1] !== undefined || m[2]) pages.push({ page: m[1] ?? 'Extruder', groups: [] });
			else if (m[3] !== undefined || m[4] !== undefined)
				pages.at(-1)?.groups.push({ group: m[3] ?? m[4] ?? '', keys: [] });
			else if (m[5] && !seen.has(m[5])) {
				const group = pages.at(-1)?.groups.at(-1);
				if (group) {
					group.keys.push(m[5]);
					seen.add(m[5]);
				}
			}
		}
		return pages
			.map((p) => ({ ...p, groups: p.groups.filter((g) => g.keys.length) }))
			.filter((p) => p.groups.length);
	};
	const next = /\nvoid Tab[A-Za-z]*::/;
	const groups = {
		process: parse(section(/\nvoid TabPrint::build\(\)/, next)),
		filament: parse(
			section(/\nvoid TabFilament::add_filament_overrides_page\(\)/, next) +
				section(/\nvoid TabFilament::build\(\)/, next)
		),
		printer: parse(
			section(/\nvoid TabPrinter::build_fff\(\)/, next) +
				section(/\nPageShp TabPrinter::build_kinematics_page\(\)/, next) +
				section(/\nvoid TabPrinter::build_unregular_pages\(/, next)
		)
	};
	const file = path.join(root!, 'app', 'src', 'lib', 'server', 'profiles', 'groups.generated.ts');
	const text = `// GENERATED by app/tools/fetch-profiles.ts --groups from Bambu Studio ${lock.tag}
// (commit ${lock.commit}), src/slic3r/GUI/Tab.cpp. Bambu Studio is AGPL-3.0, like this app.
// Do not edit: change the generator or the pin in slicer/upstream.lock and run it again.

export interface TabPage {
	page: string;
	groups: { group: string; keys: string[] }[];
}

export const TAB_GROUPS: Record<'process' | 'filament' | 'printer', TabPage[]> = ${JSON.stringify(groups, null, '\t')};
`;
	const prettier = await import('prettier');
	const config = (await prettier.resolveConfig(file)) ?? {};
	fs.writeFileSync(file, await prettier.format(text, { ...config, filepath: file }));
	const count = (k: keyof typeof groups) =>
		groups[k].reduce((n, p) => n + p.groups.reduce((m, g) => m + g.keys.length, 0), 0);
	console.log(
		`Wrote ${path.relative(root!, file)}: ${count('process')} process, ${count('filament')} filament, ${count('printer')} printer keys.`
	);
}

function main() {
	const tmp = `${out}.tmp-${process.pid}`;
	fs.rmSync(tmp, { recursive: true, force: true });
	fs.mkdirSync(tmp, { recursive: true });
	try {
		const source = fetchInto(tmp);
		const vendor = JSON.parse(fs.readFileSync(path.join(tmp, 'BBL.json'), 'utf8')) as {
			version?: string;
		};
		fs.writeFileSync(
			path.join(tmp, 'upstream.json'),
			JSON.stringify(
				{ tag: lock.tag, commit: lock.commit, vendorVersion: vendor.version ?? '' },
				null,
				'\t'
			) + '\n'
		);
		fs.rmSync(out, { recursive: true, force: true });
		fs.mkdirSync(path.dirname(out), { recursive: true });
		fs.renameSync(tmp, out);
		console.log(
			`Wrote ${path.relative(process.cwd(), out) || out}: BBL profiles ${vendor.version} from ${source}.`
		);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

main();
if (args.includes('--groups')) await writeGroups();
