// Test helpers: the fixture vendor folder and an in-memory user preset source.
import path from 'node:path';
import type { UserPresetSource } from '../library';
import type { PresetKind, UserPreset } from '$lib/shared/slicer/profiles';

export const FIXTURE = path.resolve('src/lib/server/profiles/__fixtures__/vendor');

/** A user preset source over an array (the database store has the same shape). */
export function memoryUsers(list: UserPreset[] = []): UserPresetSource & { list_: UserPreset[] } {
	return {
		list_: list,
		list: (kind?: PresetKind) => list.filter((u) => !kind || u.kind === kind),
		get: (id) => list.find((u) => u.id === id),
		byName: (kind, name) => list.find((u) => u.kind === kind && u.name === name)
	};
}
