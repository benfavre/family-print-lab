import { describe, expect, it } from 'vitest';
import { profilePatch, projectPatch } from './validation';

describe('patch schemas', () => {
	it('leave out the fields a patch does not send', () => {
		expect(projectPatch.parse({ title: 'Rocket', version: 3 })).toEqual({
			title: 'Rocket',
			version: 3
		});
		expect(profilePatch.parse({ name: 'Sam', version: 1 })).toEqual({ name: 'Sam', version: 1 });
	});

	it('still validate the fields they do send', () => {
		expect(projectPatch.safeParse({ status: 'Nope', version: 1 }).success).toBe(false);
		expect(projectPatch.safeParse({ extra: 1, version: 1 }).success).toBe(false);
		expect(projectPatch.parse({ pinned: true, version: 1 })).toEqual({ pinned: true, version: 1 });
	});
});
