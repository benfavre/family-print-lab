// Subscription providers against fake `claude` and `codex` executables that record how they were called.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeCode, codex } from './providers';

let dir = '';
const log = () =>
	fs
		.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8')
		.trim()
		.split('\n')
		.map((l) => JSON.parse(l));
const lastCall = () => log().at(-1);

// Each fake records { argv, stdin, hasApiKey } and answers like the real CLI for the flags it gets.
const RECORD = `
const fs = require('fs');
const argv = process.argv.slice(2);
let stdin = '';
process.stdin.on('data', (d) => (stdin += d)).on('end', () => {
	fs.appendFileSync(${JSON.stringify('CALLS')}, JSON.stringify({ argv, stdin, hasApiKey: !!process.env.ANTHROPIC_API_KEY }) + '\\n');
	main(argv, stdin);
});
`;

const FAKE_CLAUDE = `#!/usr/bin/env node
${RECORD}
function main(argv, stdin) {
	if (argv[0] === 'auth') return console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
	if (stdin.includes('FAIL_LOGIN')) return console.log(JSON.stringify({ type: 'result', is_error: true, result: 'Invalid API key · Please run /login' }));
	const fmt = argv[argv.indexOf('--output-format') + 1];
	if (fmt === 'json') return console.log(JSON.stringify({ type: 'result', is_error: false, structured_output: { answer: 42 } }));
	// stream-json: partial text deltas, then a result line
	for (const t of ['Hel', 'lo']) console.log(JSON.stringify({ type: 'stream_event', event: { delta: { type: 'text_delta', text: t } } }));
	console.log(JSON.stringify({ type: 'result', is_error: false, structured_output: { answer: 'image' } }));
}
`;

const FAKE_CODEX = `#!/usr/bin/env node
${RECORD}
function main(argv, stdin) {
	if (argv[0] === 'login') return console.error('Logged in using ChatGPT');
	if (argv.includes('--json')) {
		console.log(JSON.stringify({ type: 'thread.started' }));
		console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Hi from Codex' } }));
		return;
	}
	const out = argv[argv.indexOf('-o') + 1];
	const schema = JSON.parse(fs.readFileSync(argv[argv.indexOf('--output-schema') + 1], 'utf8'));
	const image = argv.includes('-i') ? fs.existsSync(argv[argv.indexOf('-i') + 1]) : false;
	fs.writeFileSync(out, JSON.stringify({ answer: 7, sawSchema: !!schema.properties, image }));
}
`;

beforeAll(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'print-lab-fake-cli-'));
	const calls = path.join(dir, 'calls.jsonl');
	for (const [name, body] of [
		['claude', FAKE_CLAUDE],
		['codex', FAKE_CODEX]
	]) {
		fs.writeFileSync(path.join(dir, name), body.replace('"CALLS"', JSON.stringify(calls)), {
			mode: 0o755
		});
	}
	process.env.ANTHROPIC_API_KEY = 'sk-should-not-leak';
});
afterAll(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	delete process.env.ANTHROPIC_API_KEY;
});

const schema = { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] };
const png = { mediaType: 'image/png' as const, data: Buffer.from('fake png').toString('base64') };

describe('Claude Code (subscription)', () => {
	const provider = () => claudeCode({ bin: path.join(dir, 'claude'), model: 'opus' });

	it('reports sign-in status', async () => {
		expect(await provider().status()).toMatchObject({
			available: true,
			detail: 'Signed in (Claude subscription)'
		});
	});

	it('runs locked down, without an API key, and returns the structured answer', async () => {
		expect(await provider().structured({ system: 'SYS', prompt: 'Question?', schema })).toEqual({
			answer: 42
		});
		const call = lastCall();
		expect(call.hasApiKey).toBe(false);
		expect(call.stdin).toBe('Question?');
		expect(call.argv).toEqual(
			expect.arrayContaining([
				'-p',
				'--tools',
				'',
				'--strict-mcp-config',
				'--no-session-persistence',
				'--model',
				'opus',
				'--json-schema'
			])
		);
		expect(call.argv).not.toContain('--bare');
		expect(call.argv[call.argv.indexOf('--system-prompt') + 1]).toBe('SYS');
	});

	it('sends images as a stream-json user message', async () => {
		expect(
			await provider().structured({ system: 'S', prompt: 'Look', schema, image: png })
		).toEqual({ answer: 'image' });
		const line = JSON.parse(lastCall().stdin);
		expect(line.type).toBe('user');
		expect(line.message.content[0]).toMatchObject({
			type: 'image',
			source: { media_type: 'image/png', data: png.data }
		});
		expect(line.message.content[1]).toEqual({ type: 'text', text: 'Look' });
	});

	it('streams chat text and passes earlier turns as a transcript', async () => {
		let text = '';
		await provider().chat(
			{
				system: 'S',
				messages: [
					{ role: 'user', content: 'First' },
					{ role: 'assistant', content: 'Reply' },
					{ role: 'user', content: 'Second' }
				]
			},
			(t) => (text += t)
		);
		expect(text).toBe('Hello');
		const content = JSON.parse(lastCall().stdin).message.content.at(-1).text;
		expect(content).toMatch(/User: First\n\nAssistant: Reply/);
		expect(content).toMatch(/new message:\nSecond$/);
	});

	it('explains a missing sign-in', async () => {
		await expect(
			provider().structured({ system: 'S', prompt: 'FAIL_LOGIN', schema })
		).rejects.toMatchObject({ status: 401, message: /not signed in/ });
	});

	it('explains a missing install', async () => {
		const missing = claudeCode({ bin: path.join(dir, 'nope') });
		expect((await missing.status()).available).toBe(false);
		await expect(missing.structured({ system: 'S', prompt: 'x', schema })).rejects.toMatchObject({
			status: 503
		});
	});

	it('stops the CLI when the request is cancelled', async () => {
		const abort = new AbortController();
		abort.abort();
		await expect(
			provider().structured({ system: 'S', prompt: 'x', schema, signal: abort.signal })
		).rejects.toMatchObject({ status: 499 });
	});
});

describe('Codex (subscription)', () => {
	const provider = () => codex({ bin: path.join(dir, 'codex'), model: 'gpt-x' });

	it('reports sign-in status', async () => {
		expect(await provider().status()).toMatchObject({
			available: true,
			detail: 'Logged in using ChatGPT'
		});
	});

	it('runs read-only and ephemeral with a schema file, attaches images, and cleans up', async () => {
		const answer = await provider().structured<{
			answer: number;
			sawSchema: boolean;
			image: boolean;
		}>({ system: 'SYS', prompt: 'Q', schema, image: png });
		expect(answer).toEqual({ answer: 7, sawSchema: true, image: true });
		const call = lastCall();
		expect(call.hasApiKey).toBe(false);
		expect(call.argv).toEqual(
			expect.arrayContaining([
				'exec',
				'--sandbox',
				'read-only',
				'--ephemeral',
				'--ignore-user-config',
				'-m',
				'gpt-x',
				'-'
			])
		);
		expect(call.stdin).toBe('SYS\n\n---\n\nQ');
		for (const flag of ['--output-schema', '-o', '-i'])
			expect(fs.existsSync(call.argv[call.argv.indexOf(flag) + 1])).toBe(false);
	});

	it('streams agent messages for chat', async () => {
		let text = '';
		await provider().chat(
			{ system: 'S', messages: [{ role: 'user', content: 'Hi' }] },
			(t) => (text += t)
		);
		expect(text).toBe('Hi from Codex');
	});
});
