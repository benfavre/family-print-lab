// User presets in the database (user_presets): a name, the system preset it inherits from and only the
// keys it changes, like Bambu Studio's user preset files (Preset::save writes the diff against the
// parent, src/libslic3r/Preset.cpp ~640).
//
// origin: BambuStudio src/libslic3r/Preset.cpp @ 926a7192574bcb9b3a732e1ec59a46d79cb45466
import crypto from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { DB } from '../db';
import { userPresets } from '../db/schema';
import { AppError } from '../validation';
import type { ConfigMap } from '$lib/shared/slicer/project';
import type { PresetKind, UserPreset } from '$lib/shared/slicer/profiles';

export interface StoredPreset extends UserPreset {
	version: number;
	createdAt: string;
}

const nowIso = () => new Date().toISOString();

export class UserPresetStore {
	constructor(private db: DB) {}

	list(kind?: PresetKind): StoredPreset[] {
		const q = this.db.select().from(userPresets);
		return (kind ? q.where(eq(userPresets.kind, kind)) : q)
			.orderBy(asc(userPresets.kind), asc(userPresets.name))
			.all();
	}

	get(id: string): StoredPreset | undefined {
		return this.db.select().from(userPresets).where(eq(userPresets.id, id)).get();
	}

	byName(kind: PresetKind, name: string): StoredPreset | undefined {
		return this.db
			.select()
			.from(userPresets)
			.where(and(eq(userPresets.kind, kind), eq(userPresets.name, name)))
			.get();
	}

	create(p: { kind: PresetKind; name: string; inherits: string | null; config: ConfigMap }) {
		if (this.byName(p.kind, p.name))
			throw new AppError(409, `You already have a ${p.kind} preset called “${p.name}”.`);
		const id = crypto.randomUUID();
		this.db
			.insert(userPresets)
			.values({ id, ...p })
			.run();
		return this.get(id)!;
	}

	/** Changes name and/or keys; `version` must match (someone else may have saved in between). */
	update(id: string, version: number, change: { name?: string; config?: ConfigMap }) {
		const before = this.get(id);
		if (!before) throw new AppError(404, 'That preset no longer exists.');
		if (change.name && change.name !== before.name) {
			const clash = this.byName(before.kind, change.name);
			if (clash) throw new AppError(409, `You already have a preset called “${change.name}”.`);
		}
		const r = this.db
			.update(userPresets)
			.set({ ...change, version: sql`${userPresets.version} + 1`, updatedAt: nowIso() })
			.where(and(eq(userPresets.id, id), eq(userPresets.version, version)))
			.run();
		if (r.changes === 0)
			throw new AppError(409, 'This preset was changed somewhere else. Reload and try again.');
		return this.get(id)!;
	}

	/** Creates or replaces by name (imports). */
	upsert(p: { kind: PresetKind; name: string; inherits: string | null; config: ConfigMap }) {
		const existing = this.byName(p.kind, p.name);
		if (!existing) return { preset: this.create(p), replaced: false };
		this.db
			.update(userPresets)
			.set({
				inherits: p.inherits,
				config: p.config,
				version: sql`${userPresets.version} + 1`,
				updatedAt: nowIso()
			})
			.where(eq(userPresets.id, existing.id))
			.run();
		return { preset: this.get(existing.id)!, replaced: true };
	}

	remove(id: string) {
		if (this.db.delete(userPresets).where(eq(userPresets.id, id)).run().changes === 0)
			throw new AppError(404, 'That preset no longer exists.');
	}
}
