// AI providers behind one interface: Claude Code (Claude subscription), Codex (ChatGPT subscription)
// and the Anthropic API. The CLIs run headless with every tool disabled, in an empty scratch
// directory, without the user's project settings or MCP servers, so they can only answer.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { AppError } from '../validation';

import { AI_PROVIDERS, type AiProviderId } from '$lib/shared/integrations';

export const PROVIDERS = AI_PROVIDERS;
export type ProviderId = AiProviderId;
export const PROVIDER_LABEL: Record<ProviderId, string> = {
	'claude-code': 'Claude (subscription, via Claude Code)',
	codex: 'ChatGPT (subscription, via Codex)',
	'anthropic-api': 'Anthropic API key'
};

export interface Image {
	mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
	data: string;
}
export interface StructuredRequest {
	system: string;
	prompt: string;
	schema: Record<string, unknown>;
	image?: Image | null;
	effort?: 'low' | 'medium' | 'high';
	signal?: AbortSignal;
}
export interface ChatMessage {
	role: 'user' | 'assistant';
	content: string;
}
export interface ChatRequest {
	system: string;
	messages: ChatMessage[];
	image?: Image | null;
	signal?: AbortSignal;
}
export interface ProviderStatus {
	id: ProviderId;
	label: string;
	available: boolean;
	detail: string;
}
export interface Provider {
	id: ProviderId;
	status(): Promise<ProviderStatus>;
	structured<T = unknown>(req: StructuredRequest): Promise<T>;
	chat(req: ChatRequest, onText: (text: string) => void): Promise<void>;
}

// ---------- Process plumbing ----------

export function findBin(name: string, override?: string) {
	if (override) return fs.existsSync(override) ? override : null;
	for (const dir of [
		path.join(os.homedir(), '.local/bin'),
		...(process.env.PATH ?? '').split(path.delimiter)
	]) {
		const p = path.join(dir, name);
		if (dir && fs.existsSync(p)) return p;
	}
	return null;
}

const scratch = () => {
	const dir = path.join(os.tmpdir(), 'family-print-lab-ai');
	fs.mkdirSync(dir, { recursive: true });
	return dir;
};

/** Subscription mode: never let an API key in the environment take over billing. */
function subscriptionEnv() {
	const env = { ...process.env };
	delete env.ANTHROPIC_API_KEY;
	delete env.ANTHROPIC_AUTH_TOKEN;
	delete env.OPENAI_API_KEY;
	return env;
}

// At most two CLI conversations at once; further requests wait their turn.
let active = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
	if (active >= 2) await new Promise<void>((r) => waiting.push(r));
	active++;
	try {
		return await fn();
	} finally {
		active--;
		waiting.shift()?.();
	}
}

interface RunOptions {
	input?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	onLine?: (line: string) => void;
}

function runCli(
	bin: string,
	args: string[],
	{ input = '', timeoutMs = 300_000, signal, onLine }: RunOptions = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new AppError(499, 'Cancelled.'));
		const child = spawn(bin, args, {
			cwd: scratch(),
			env: subscriptionEnv(),
			stdio: ['pipe', 'pipe', 'pipe']
		});
		let stdout = '',
			stderr = '',
			buffer = '';
		child.stdout.on('data', (d: Buffer) => {
			const text = d.toString();
			stdout += text;
			if (onLine) {
				buffer += text;
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';
				for (const line of lines) if (line.trim()) onLine(line);
			}
		});
		child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
		const kill = () => child.kill('SIGTERM');
		const timer = setTimeout(kill, timeoutMs);
		signal?.addEventListener('abort', kill, { once: true });
		child.on('error', (e) => {
			clearTimeout(timer);
			reject(new AppError(503, `Could not start ${path.basename(bin)}: ${e.message}`));
		});
		child.on('close', (code, sig) => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', kill);
			if (buffer.trim() && onLine) onLine(buffer);
			if (signal?.aborted) return reject(new AppError(499, 'Cancelled.'));
			if (sig)
				return reject(new AppError(504, `${path.basename(bin)} took too long and was stopped.`));
			resolve({ code: code ?? 1, stdout, stderr });
		});
		child.stdin.end(input);
	});
}

/** Single-turn CLIs get the conversation as a transcript. */
function transcript(messages: ChatMessage[]) {
	const history = messages
		.slice(0, -1)
		.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
		.join('\n\n');
	const last = messages.at(-1)?.content ?? '';
	return history ? `Conversation so far:\n\n${history}\n\nUser's new message:\n${last}` : last;
}

// ---------- Claude Code ----------

export function claudeCode(options: { bin?: string; model?: string } = {}): Provider {
	const bin = () => findBin('claude', options.bin);
	const base = (system: string) => [
		'-p',
		'--tools',
		'',
		'--setting-sources',
		'',
		'--strict-mcp-config',
		'--no-session-persistence',
		'--system-prompt',
		system,
		...(options.model ? ['--model', options.model] : [])
	];
	const userLine = (text: string, image?: Image | null) =>
		JSON.stringify({
			type: 'user',
			message: {
				role: 'user',
				content: [
					...(image
						? [
								{
									type: 'image',
									source: { type: 'base64', media_type: image.mediaType, data: image.data }
								}
							]
						: []),
					{ type: 'text', text }
				]
			}
		}) + '\n';
	const need = () => {
		const b = bin();
		if (!b)
			throw new AppError(
				503,
				'Claude Code is not installed. Install it and run `claude` once to sign in.'
			);
		return b;
	};
	const failure = (text: string) =>
		new AppError(
			/log ?in|login|auth/i.test(text) ? 401 : 502,
			/log ?in|login/i.test(text)
				? 'Claude Code is not signed in. Run `claude` in a terminal and use /login.'
				: `Claude Code: ${text.slice(0, 300)}`
		);

	return {
		id: 'claude-code',
		async status() {
			const b = bin();
			if (!b)
				return {
					id: 'claude-code',
					label: PROVIDER_LABEL['claude-code'],
					available: false,
					detail: 'Claude Code CLI not found.'
				};
			try {
				const { stdout } = await runCli(b, ['auth', 'status'], { timeoutMs: 20_000 });
				const s = JSON.parse(stdout);
				return {
					id: 'claude-code',
					label: PROVIDER_LABEL['claude-code'],
					available: !!s.loggedIn,
					detail: s.loggedIn
						? `Signed in (${s.authMethod === 'claude.ai' ? 'Claude subscription' : s.authMethod})`
						: 'Not signed in: run `claude` and /login.'
				};
			} catch {
				return {
					id: 'claude-code',
					label: PROVIDER_LABEL['claude-code'],
					available: false,
					detail: 'Could not read Claude Code sign-in status.'
				};
			}
		},
		structured<T>(req: StructuredRequest) {
			return slot(async () => {
				const args = [...base(req.system), '--json-schema', JSON.stringify(req.schema)];
				let result:
					{ is_error?: boolean; result?: string; structured_output?: unknown } | undefined;
				if (req.image) {
					const out = await runCli(
						need(),
						[
							...args,
							'--input-format',
							'stream-json',
							'--output-format',
							'stream-json',
							'--verbose'
						],
						{ input: userLine(req.prompt, req.image), signal: req.signal }
					);
					result = out.stdout
						.split('\n')
						.map((l) => {
							try {
								return JSON.parse(l);
							} catch {
								return null;
							}
						})
						.find((e) => e?.type === 'result');
				} else {
					const out = await runCli(need(), [...args, '--output-format', 'json'], {
						input: req.prompt,
						signal: req.signal
					});
					try {
						result = JSON.parse(out.stdout);
					} catch {
						throw failure(out.stderr || out.stdout);
					}
				}
				if (!result || result.is_error) throw failure(String(result?.result ?? 'no result'));
				if (result.structured_output === undefined)
					throw new AppError(502, 'Claude Code returned no structured answer.');
				return result.structured_output as T;
			});
		},
		chat(req, onText) {
			return slot(async () => {
				let failed = '';
				await runCli(
					need(),
					[
						...base(req.system),
						'--input-format',
						'stream-json',
						'--output-format',
						'stream-json',
						'--verbose',
						'--include-partial-messages'
					],
					{
						input: userLine(transcript(req.messages), req.image),
						signal: req.signal,
						onLine: (line) => {
							let e;
							try {
								e = JSON.parse(line);
							} catch {
								return;
							}
							if (e.type === 'stream_event' && e.event?.delta?.type === 'text_delta')
								onText(e.event.delta.text);
							if (e.type === 'result' && e.is_error) failed = String(e.result);
						}
					}
				);
				if (failed) throw failure(failed);
			});
		}
	};
}

// ---------- Codex ----------

export function codex(options: { bin?: string; model?: string } = {}): Provider {
	const bin = () => findBin('codex', options.bin);
	const need = () => {
		const b = bin();
		if (!b) throw new AppError(503, 'Codex is not installed. Install it and run `codex login`.');
		return b;
	};
	const tmp = (ext: string) => path.join(scratch(), `${crypto.randomUUID()}${ext}`);
	const base = [
		'exec',
		'--sandbox',
		'read-only',
		'--skip-git-repo-check',
		'--ephemeral',
		'--ignore-user-config',
		'--color',
		'never',
		'-C',
		scratch(),
		...(options.model ? ['-m', options.model] : [])
	];
	const withImage = (image: Image | null | undefined, files: string[]) => {
		if (!image) return [];
		const file = tmp(
			image.mediaType === 'image/png'
				? '.png'
				: image.mediaType === 'image/webp'
					? '.webp'
					: image.mediaType === 'image/gif'
						? '.gif'
						: '.jpg'
		);
		fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
		files.push(file);
		return ['-i', file];
	};
	const failure = (stderr: string) =>
		new AppError(
			/log ?in|auth|401/i.test(stderr) ? 401 : 502,
			/log ?in|401/i.test(stderr)
				? 'Codex is not signed in. Run `codex login`.'
				: `Codex: ${stderr
						.split('\n')
						.filter((l) => !/rmcp|WARN/.test(l))
						.slice(-3)
						.join(' ')
						.slice(0, 300)}`
		);

	return {
		id: 'codex',
		async status() {
			const b = bin();
			if (!b)
				return {
					id: 'codex',
					label: PROVIDER_LABEL.codex,
					available: false,
					detail: 'Codex CLI not found.'
				};
			try {
				const { stdout, stderr } = await runCli(b, ['login', 'status'], { timeoutMs: 20_000 });
				const text = `${stdout}${stderr}`.trim();
				const ok = /logged in/i.test(text);
				return {
					id: 'codex',
					label: PROVIDER_LABEL.codex,
					available: ok,
					detail: ok ? text.split('\n')[0] : 'Not signed in: run `codex login`.'
				};
			} catch {
				return {
					id: 'codex',
					label: PROVIDER_LABEL.codex,
					available: false,
					detail: 'Could not read Codex sign-in status.'
				};
			}
		},
		structured<T>(req: StructuredRequest) {
			return slot(async () => {
				const files: string[] = [];
				const schemaFile = tmp('.json'),
					outFile = tmp('.txt');
				files.push(schemaFile, outFile);
				fs.writeFileSync(schemaFile, JSON.stringify(req.schema));
				try {
					const out = await runCli(
						need(),
						[
							...base,
							'--output-schema',
							schemaFile,
							'-o',
							outFile,
							...withImage(req.image, files),
							'-'
						],
						{ input: `${req.system}\n\n---\n\n${req.prompt}`, signal: req.signal }
					);
					if (out.code !== 0 || !fs.existsSync(outFile)) throw failure(out.stderr);
					try {
						return JSON.parse(fs.readFileSync(outFile, 'utf8')) as T;
					} catch {
						throw new AppError(502, 'Codex returned an unreadable answer.');
					}
				} finally {
					for (const f of files) fs.rmSync(f, { force: true });
				}
			});
		},
		chat(req, onText) {
			return slot(async () => {
				const files: string[] = [];
				try {
					let said = false;
					const out = await runCli(
						need(),
						[...base, '--json', ...withImage(req.image, files), '-'],
						{
							input: `${req.system}\n\n---\n\n${transcript(req.messages)}`,
							signal: req.signal,
							onLine: (line) => {
								let e;
								try {
									e = JSON.parse(line);
								} catch {
									return;
								}
								if (
									e.type === 'item.completed' &&
									e.item?.type === 'agent_message' &&
									e.item.text
								) {
									onText((said ? '\n\n' : '') + e.item.text);
									said = true;
								}
							}
						}
					);
					if (!said) throw failure(out.stderr);
				} finally {
					for (const f of files) fs.rmSync(f, { force: true });
				}
			});
		}
	};
}

// ---------- Anthropic API (key) ----------

// The SDK's beta surface (fallbacks, output_config) is used through a narrow structural type so tests can stub it.
interface ContentBlock {
	type: string;
	text?: string;
}
interface ClaudeMessage {
	stop_reason?: string | null;
	content: ContentBlock[];
}
interface StreamEvent {
	type: string;
	delta?: { type: string; text?: string };
}
export interface AnyClient {
	beta: {
		messages: {
			create(params: Record<string, unknown>): Promise<ClaudeMessage>;
			stream(
				params: Record<string, unknown>
			): AsyncIterable<StreamEvent> & { finalMessage(): Promise<ClaudeMessage> };
		};
	};
}

export function anthropicApi(
	options: {
		client?: AnyClient | null;
		env?: Record<string, string | undefined>;
		model?: string;
	} = {}
): Provider {
	const env = options.env ?? process.env;
	const model = options.model || env.LAB_AI_MODEL || 'claude-opus-5';
	const configured = !!(options.client || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
	let sdk = options.client ?? null;
	const api = (): AnyClient => {
		if (!configured)
			throw new AppError(
				503,
				'No Anthropic API key is set. Add ANTHROPIC_API_KEY to .env, or use a subscription provider (see Integrations).'
			);
		return (sdk ??= new Anthropic() as unknown as AnyClient);
	};
	const base = {
		model,
		betas: ['server-side-fallback-2026-07-01'],
		fallbacks: 'default',
		thinking: { type: 'adaptive' },
		max_tokens: 16000
	};
	const explain = (error: unknown) => {
		if (error instanceof AppError) return error;
		if (error instanceof Anthropic.AuthenticationError)
			return new AppError(401, 'Anthropic rejected the API key.');
		if (error instanceof Anthropic.RateLimitError)
			return new AppError(429, 'Rate limited by Anthropic. Wait a moment and try again.');
		if (error instanceof Anthropic.APIConnectionError)
			return new AppError(502, 'Could not reach Anthropic.');
		if (error instanceof Anthropic.APIError)
			return new AppError(502, `Anthropic error ${error.status ?? ''}: ${error.message}`.trim());
		return new AppError(500, 'The assistant failed unexpectedly.');
	};
	const content = (text: string, image?: Image | null) => [
		...(image
			? [
					{
						type: 'image',
						source: { type: 'base64', media_type: image.mediaType, data: image.data }
					}
				]
			: []),
		{ type: 'text', text }
	];
	return {
		id: 'anthropic-api',
		async status() {
			return {
				id: 'anthropic-api',
				label: PROVIDER_LABEL['anthropic-api'],
				available: configured,
				detail: configured ? `API key set · ${model}` : 'No ANTHROPIC_API_KEY in .env'
			};
		},
		async structured<T>(req: StructuredRequest) {
			try {
				const message = await api().beta.messages.create({
					...base,
					output_config: {
						effort: req.effort ?? 'medium',
						format: { type: 'json_schema', schema: req.schema }
					},
					system: req.system,
					messages: [{ role: 'user', content: content(req.prompt, req.image) }]
				});
				if (message.stop_reason === 'refusal')
					throw new AppError(422, 'Claude declined this request. Try rephrasing it.');
				if (message.stop_reason === 'max_tokens')
					throw new AppError(502, 'The answer was cut off. Try a narrower request.');
				return JSON.parse(
					message.content
						.filter((b) => b.type === 'text')
						.map((b) => b.text ?? '')
						.join('')
				) as T;
			} catch (error) {
				throw error instanceof SyntaxError
					? new AppError(502, 'The assistant returned an unreadable answer.')
					: explain(error);
			}
		},
		async chat(req, onText) {
			try {
				const messages = req.messages.map((m, i) => ({
					role: m.role,
					content:
						i === req.messages.length - 1 && m.role === 'user'
							? content(m.content, req.image)
							: m.content
				}));
				const stream = api().beta.messages.stream({
					...base,
					output_config: { effort: 'medium' },
					system: req.system,
					messages
				});
				for await (const event of stream)
					if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta')
						onText(event.delta.text ?? '');
				const final = await stream.finalMessage();
				if (final.stop_reason === 'refusal')
					onText('\n\n(Claude declined to continue this answer.)');
			} catch (error) {
				throw explain(error);
			}
		}
	};
}
