import { describe, expect, it } from 'vitest';
import { TaskCenter } from './tasks';
import type { TaskInfo } from '$lib/shared/tasks';

const settle = () => new Promise((r) => setTimeout(r, 10));

describe('background tasks', () => {
	it('broadcasts every stage and the result, independently of the caller', async () => {
		const center = new TaskCenter();
		const seen: string[] = [];
		center.events.on('task', (t: TaskInfo) => seen.push(`${t.status}:${t.stage}`));
		const task = center.start(
			{
				kind: 'ai-design',
				title: 'Coaster',
				projectId: 'p1',
				provider: 'claude-code',
				stage: 'Asking Claude…'
			},
			async (ctx) => {
				ctx.stage('Test-rendering the design…');
				await settle();
				return { summary: 'A coaster' };
			},
			(r) => ({ versionId: r.summary })
		);
		expect(task.status).toBe('running');
		await settle();
		await settle();
		expect(center.get(task.id)).toMatchObject({ status: 'done', versionId: 'A coaster' });
		expect(seen).toEqual([
			'running:Asking Claude…',
			'running:Test-rendering the design…',
			'done:Done'
		]);
	});

	it('cancels through the abort signal, records failures, and forgets finished tasks on request', async () => {
		const center = new TaskCenter();
		const slow = center.start(
			{ kind: 'ai-edit', title: 'Slow' },
			(ctx) =>
				new Promise((_, fail) =>
					ctx.signal.addEventListener('abort', () => fail(new Error('aborted')))
				)
		);
		center.cancel(slow.id);
		await settle();
		expect(center.get(slow.id)).toMatchObject({ status: 'cancelled', error: null });
		const bad = center.start({ kind: 'blender-repair', title: 'Bad' }, async () => {
			throw new Error('Blender failed: no mesh');
		});
		await settle();
		expect(center.get(bad.id)).toMatchObject({
			status: 'failed',
			error: 'Blender failed: no mesh'
		});
		center.dismiss(bad.id);
		expect(() => center.get(bad.id)).toThrow(/no longer known/);
		await expect(center.run({ kind: 'blender-repair', title: 'x' }, async () => 7)).resolves.toBe(
			7
		);
	});

	it('keeps long-lived tasks open until they are ended or cancelled', async () => {
		const center = new TaskCenter();
		let closed = false;
		const session = center.open({ kind: 'blender-session', title: 'Hook' }, () => (closed = true));
		session.stage('Imported 1 save');
		expect(center.get(session.info.id)).toMatchObject({
			status: 'running',
			stage: 'Imported 1 save'
		});
		session.end();
		await settle();
		expect(center.get(session.info.id).status).toBe('done');
		const other = center.open({ kind: 'blender-session', title: 'Other' }, () => (closed = true));
		center.cancel(other.info.id);
		expect(closed).toBe(true);
	});
});
