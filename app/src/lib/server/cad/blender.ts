// Blender bridge: headless jobs (repair, decimate) and interactive "Open in Blender" sessions whose
// saves flow back into the app as new model versions.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../validation';

const SCRIPTS = path.resolve('resources/blender');

/** Finds Blender: BLENDER_PATH, then the newest portable install in ~/.local/opt, then PATH. */
export function findBlender(env: Record<string, string | undefined> = process.env): string | null {
	if (env.BLENDER_PATH && fs.existsSync(env.BLENDER_PATH)) return env.BLENDER_PATH;
	const opt = path.join(os.homedir(), '.local/opt');
	if (fs.existsSync(opt)) {
		const installs = fs
			.readdirSync(opt)
			.filter((d) => /^blender-\d/.test(d) && fs.existsSync(path.join(opt, d, 'blender')))
			.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
		if (installs.length) return path.join(opt, installs[0], 'blender');
	}
	for (const dir of (env.PATH ?? '').split(path.delimiter)) {
		const candidate = path.join(dir, 'blender');
		if (dir && fs.existsSync(candidate)) return candidate;
	}
	return null;
}

export interface BlenderInfo {
	available: boolean;
	path: string | null;
	version: string | null;
}

let cachedVersion: { path: string; version: string } | null = null;
export async function blenderInfo(): Promise<BlenderInfo> {
	const bin = findBlender();
	if (!bin) return { available: false, path: null, version: null };
	if (cachedVersion?.path !== bin) {
		const out = await run(bin, ['--version'], 30_000).catch(() => ({ stdout: '', stderr: '' }));
		cachedVersion = { path: bin, version: out.stdout.split('\n')[0]?.trim() || 'Blender' };
	}
	return { available: true, path: bin, version: cachedVersion.version };
}

function run(
	bin: string,
	args: string[],
	timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '',
			stderr = '';
		child.stdout.on('data', (d) => (stdout += d));
		child.stderr.on('data', (d) => (stderr += d));
		const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
		child.on('error', (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on('close', (code, signal) => {
			clearTimeout(timer);
			if (signal === 'SIGKILL') reject(new AppError(504, 'Blender took too long and was stopped.'));
			else if (code !== 0)
				reject(
					new AppError(
						502,
						`Blender failed: ${(stderr || stdout).split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300)}`
					)
				);
			else resolve({ stdout, stderr });
		});
	});
}

/** Runs one of resources/blender/*.py headless on an STL and returns the script's RESULT payload. */
export async function runJob(
	script: 'repair' | 'decimate',
	input: string,
	output: string,
	extra: string[] = [],
	timeoutMs = 180_000
): Promise<Record<string, unknown>> {
	const bin = findBlender();
	if (!bin) throw new AppError(503, 'Blender is not installed. See Integrations for setup.');
	const { stdout } = await run(
		bin,
		[
			'-b',
			'--factory-startup',
			'--python',
			path.join(SCRIPTS, `${script}.py`),
			'--',
			input,
			output,
			...extra
		],
		timeoutMs
	);
	const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
	if (!line || !fs.existsSync(output))
		throw new AppError(502, 'Blender finished without producing a result.');
	return JSON.parse(line.slice(7));
}

export interface Session {
	modelId: string;
	exportPath: string;
	pid: number;
	stop(): void;
}

/**
 * Opens a model in the Blender window. `onSave` fires with the exported STL each time the user
 * saves in Blender; the watch ends when Blender closes.
 */
export function openSession(opts: {
	modelId: string;
	name: string;
	input: string;
	workDir: string;
	/** Imports a save; returns the stored file it became, so the next session can continue from the .blend. */
	onSave: (file: string) => string | void;
	onClose: () => void;
	/** What Blender reports about the session (ready, problems). */
	onStatus?: (text: string, problem: boolean) => void;
}): Session {
	const bin = findBlender();
	if (!bin) throw new AppError(503, 'Blender is not installed. See Integrations for setup.');
	fs.mkdirSync(opts.workDir, { recursive: true });
	const exportPath = path.join(opts.workDir, 'from-blender.stl');
	const blendPath = path.join(opts.workDir, 'session.blend');
	// The .blend (with the user's Blender-only work) is reused only if it still matches the model's current
	// version; if the model changed in the lab since, start fresh from the current mesh.
	const marker = path.join(opts.workDir, 'source.txt');
	const source = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
	if (source !== opts.input) {
		for (const f of [blendPath, `${blendPath}1`, exportPath]) fs.rmSync(f, { force: true });
		fs.writeFileSync(marker, opts.input);
	}
	const child = spawn(
		bin,
		[
			// Continue in the earlier working file when there is one; Blender opens it before the script runs.
			...(fs.existsSync(blendPath) ? [blendPath] : []),
			'--python',
			path.join(SCRIPTS, 'session.py'),
			'--',
			opts.input,
			exportPath,
			opts.name,
			blendPath
		],
		{ stdio: ['ignore', 'pipe', 'pipe'], detached: false }
	);
	// Keep Blender's own output next to the session, for when something goes wrong.
	const log = fs.createWriteStream(path.join(opts.workDir, 'blender.log'), { flags: 'w' });
	child.stdout?.pipe(log);
	child.stderr?.pipe(log);
	// Pass the session script's own messages on, so problems show up in the app, not only in the log.
	let pending = '';
	child.stdout?.on('data', (chunk: Buffer) => {
		pending += chunk.toString();
		const lines = pending.split('\n');
		pending = lines.pop() ?? '';
		for (const line of lines) {
			const m = line.match(/^Family Print Lab: (.*)$/);
			if (m) opts.onStatus?.(m[1], /could not|failed/i.test(m[1]));
		}
	});
	let last = fs.existsSync(exportPath) ? fs.statSync(exportPath).mtimeMs : 0;
	const check = () => {
		try {
			const stat = fs.statSync(exportPath);
			if (stat.mtimeMs > last && stat.size > 84) {
				last = stat.mtimeMs;
				const stored = opts.onSave(exportPath);
				if (stored) fs.writeFileSync(marker, stored);
			}
		} catch {
			/* not saved yet */
		}
	};
	const poll = setInterval(check, 1000);
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		clearInterval(poll);
		check(); // a save made just before quitting
		opts.onClose();
	};
	const stop = () => {
		clearInterval(poll);
		if (!child.killed && child.exitCode === null) child.kill('SIGTERM');
	};
	child.on('exit', close);
	child.on('error', close);
	return { modelId: opts.modelId, exportPath, pid: child.pid ?? -1, stop };
}
