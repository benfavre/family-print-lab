import { describe, expect, it } from 'vitest';
import { createAi, snapshot } from './assistant';
import { anthropicApi, type AnyClient } from './providers';
import { openDatabase } from '../db';
import { Lab } from '../lab';
import { AppError } from '../validation';

function stub(reply: unknown) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const calls: any[] = [];
	const message = (text: string, stop = 'end_turn') => ({
		stop_reason: stop,
		content: [{ type: 'text', text }]
	});
	const client: AnyClient = {
		beta: {
			messages: {
				create: async (params: Record<string, unknown>) => {
					calls.push(params);
					return typeof reply === 'function' ? reply(params) : message(JSON.stringify(reply));
				},
				stream: (params: Record<string, unknown>) => {
					calls.push(params);
					const parts = ['Measure ', 'first.'];
					return {
						async *[Symbol.asyncIterator]() {
							for (const text of parts)
								yield { type: 'content_block_delta', delta: { type: 'text_delta', text } };
						},
						finalMessage: async () => message(parts.join(''))
					};
				}
			}
		}
	};
	return { client, calls };
}

function workspace() {
	const lab = new Lab(openDatabase(':memory:'));
	const son = lab.createProfile({ name: 'Son', age: 7, color: 'blue', interests: 'space' });
	lab.createProject({ profileId: son, title: 'Rocket cup' });
	return { lab, son };
}

describe('lab assistant', () => {
	it('asks Opus 5 with server-side fallbacks, a JSON schema and the workspace snapshot', async () => {
		const { lab, son } = workspace();
		const { client, calls } = stub({
			ideas: [
				{
					title: 'Planet lamp',
					category: 'Home',
					description: 'A moon.',
					material: 'PLA',
					why: 'Space.',
					safety: '',
					checklist: ['Measure']
				}
			]
		});
		const ai = createAi(() => anthropicApi({ client }));
		const result = await ai.run(
			'ideas',
			lab.snapshot(),
			{ configured: false },
			{ profileId: son, hint: 'glow' }
		);
		expect(result.ideas[0].title).toBe('Planet lamp');
		expect(calls[0]).toMatchObject({
			model: 'claude-opus-5',
			fallbacks: 'default',
			betas: ['server-side-fallback-2026-07-01'],
			output_config: { format: { type: 'json_schema' } }
		});
		expect(calls[0].system).toMatch(/Son \(age 7\)/);
		expect(calls[0].messages[0].content.at(-1).text).toMatch(/glow/);
	});

	it('streams chat and validates the conversation shape', async () => {
		const { lab } = workspace();
		const ai = createAi(() => anthropicApi({ client: stub({}).client }));
		let text = '';
		await ai.chat(
			lab.snapshot(),
			{ configured: false },
			[{ role: 'user', content: 'Where do I start?' }],
			(t) => (text += t)
		);
		expect(text).toBe('Measure first.');
		await expect(
			ai.chat(
				lab.snapshot(),
				{ configured: false },
				[{ role: 'assistant', content: 'hi' }],
				() => {}
			)
		).rejects.toBeInstanceOf(AppError);
	});

	it('explains refusals, rejects unsafe images, and reports when it is not set up', async () => {
		const { lab, son } = workspace();
		const refusing = createAi(() =>
			anthropicApi({ client: stub(() => ({ stop_reason: 'refusal', content: [] })).client })
		);
		await expect(
			refusing.run('ideas', lab.snapshot(), { configured: false }, { profileId: son })
		).rejects.toMatchObject({ status: 422 });
		const ai = createAi(() => anthropicApi({ client: stub({}).client }));
		await expect(
			ai.run(
				'diagnose',
				lab.snapshot(),
				{ configured: false },
				{ jobId: 'x', image: { mediaType: 'image/svg+xml', data: 'AAAA' } }
			)
		).rejects.toMatchObject({ status: 400 });
		const off = createAi(() => anthropicApi({ env: {} }));
		await expect(
			off.run('ideas', lab.snapshot(), { configured: false }, { profileId: son })
		).rejects.toMatchObject({ status: 503 });
	});

	it('summarises printer state for the model', () => {
		const { lab } = workspace();
		expect(snapshot(lab.snapshot(), { configured: false })).toMatch(/not connected/);
		const text = snapshot(lab.snapshot(), {
			configured: true,
			connected: true,
			name: 'X2D',
			state: {
				gcodeState: 'RUNNING',
				task: 'dock',
				percent: 5,
				layer: null,
				totalLayers: null,
				remainingMinutes: null,
				nozzle: 220,
				nozzleTarget: 220,
				bed: null,
				bedTarget: null,
				chamber: null,
				speedLevel: null,
				printError: 0,
				hms: [],
				wifiSignal: '',
				ams: []
			}
		});
		expect(text).toMatch(/X2D: RUNNING, task "dock", 5%/);
	});
});
