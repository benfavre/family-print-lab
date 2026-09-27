// Saved smart plugs: one per printer, versioned like the lab's other records. Secrets stay here; the
// browser gets PlugInfo, which says hasPassword / hasToken instead.
import { and, eq } from 'drizzle-orm';
import type { DB } from '../../db';
import { plugs, printers } from '../../db/schema';
import { AppError, parse } from '../../validation';
import type { PlugInfo, PlugKind } from '$lib/shared/home-automation';
import { plugInput, plugPatch, type PlugConfig, type PlugConfigInput } from './validation';

export interface Plug extends Omit<PlugInfo, 'config'> {
	config: PlugConfig;
}

type Row = typeof plugs.$inferSelect;

const fromRow = (row: Row): Plug => {
	let config: PlugConfig = {};
	try {
		config = JSON.parse(row.config) as PlugConfig;
	} catch {
		/* a broken row reads as an empty config: the plug then says what is missing */
	}
	const { config: _, ...rest } = row;
	return { ...rest, config };
};

/** The browser's view: no password, no token. */
export function plugView(plug: Plug): PlugInfo {
	const { password, token, ...config } = plug.config;
	return { ...plug, config: { ...config, hasPassword: !!password, hasToken: !!token } };
}

/** Applies a config input over a stored config: empty or missing secrets keep the stored ones, null clears. */
function mergeConfig(stored: PlugConfig, input: PlugConfigInput, kind: PlugKind): PlugConfig {
	const out: PlugConfig = { ...stored };
	for (const [k, v] of Object.entries(input) as [keyof PlugConfig, unknown][]) {
		if (k === 'password' || k === 'token') {
			if (v === null) delete out[k];
			else if (typeof v === 'string' && v !== '') out[k] = v;
			continue;
		}
		if (v === undefined || v === '') delete out[k];
		else (out as Record<string, unknown>)[k] = v;
	}
	// Only what this kind uses (a kind change leaves nothing stale behind, secrets included).
	const keep: Record<PlugKind, (keyof PlugConfig)[]> = {
		tasmota: ['url', 'user', 'password'],
		shelly: ['url', 'user', 'password', 'channel'],
		'shelly-rpc': ['url', 'password', 'channel'],
		homeassistant: ['url', 'entityId', 'token'],
		webhook: ['onUrl', 'offUrl', 'method']
	};
	for (const k of Object.keys(out) as (keyof PlugConfig)[])
		if (!keep[kind].includes(k)) delete out[k];
	return out;
}

/** What a kind needs before it can work, in plain words. */
export function missing(kind: PlugKind, c: PlugConfig): string | null {
	if (kind === 'webhook')
		return c.onUrl && c.offUrl ? null : 'Add both addresses: one to switch on, one to switch off.';
	if (!c.url) return 'Add the address of the plug.';
	if (kind === 'homeassistant') {
		if (!c.entityId) return 'Add the entity id of the plug, like switch.printer_plug.';
		if (!c.token) return 'Add a long-lived access token from your Home Assistant profile.';
	}
	return null;
}

export class PlugStore {
	constructor(
		private db: DB,
		private onChange: () => void = () => {}
	) {}

	list(): Plug[] {
		return this.db.select().from(plugs).all().map(fromRow);
	}

	get(id: string): Plug | undefined {
		const row = this.db.select().from(plugs).where(eq(plugs.id, id)).get();
		return row && fromRow(row);
	}

	require(id: string): Plug {
		const plug = this.get(id);
		if (!plug) throw new AppError(404, 'That plug no longer exists.');
		return plug;
	}

	forPrinter(printerId: string): Plug | undefined {
		const row = this.db.select().from(plugs).where(eq(plugs.printerId, printerId)).get();
		return row && fromRow(row);
	}

	create(input: unknown): Plug {
		const v = parse(plugInput, input);
		if (!this.db.select().from(printers).where(eq(printers.id, v.printerId)).get())
			throw new AppError(404, 'That printer no longer exists.');
		if (this.forPrinter(v.printerId))
			throw new AppError(409, 'This printer already has a plug. Edit that one instead.');
		const config = mergeConfig({}, v.config, v.kind);
		const problem = missing(v.kind, config);
		if (problem) throw new AppError(400, problem);
		const id = crypto.randomUUID();
		this.db
			.insert(plugs)
			.values({
				id,
				printerId: v.printerId,
				kind: v.kind,
				config: JSON.stringify(config),
				autoOn: v.autoOn ?? true,
				autoOff: v.autoOff ?? false,
				cooldownMinutes: v.cooldownMinutes ?? 10,
				offBelowNozzle: v.offBelowNozzle ?? 50
			})
			.run();
		this.onChange();
		return this.require(id);
	}

	update(id: string, input: unknown): Plug {
		const v = parse(plugPatch, input);
		const plug = this.require(id);
		if (plug.version !== v.version)
			throw new AppError(409, 'Someone changed this plug meanwhile. Look again and retry.');
		const kind = v.kind ?? plug.kind;
		const config = mergeConfig(plug.config, v.config ?? {}, kind);
		const problem = missing(kind, config);
		if (problem) throw new AppError(400, problem);
		const done = this.db
			.update(plugs)
			.set({
				kind,
				config: JSON.stringify(config),
				...(v.autoOn !== undefined && { autoOn: v.autoOn }),
				...(v.autoOff !== undefined && { autoOff: v.autoOff }),
				...(v.cooldownMinutes !== undefined && { cooldownMinutes: v.cooldownMinutes }),
				...(v.offBelowNozzle !== undefined && { offBelowNozzle: v.offBelowNozzle }),
				version: plug.version + 1,
				updatedAt: new Date().toISOString()
			})
			.where(and(eq(plugs.id, id), eq(plugs.version, plug.version)))
			.run();
		if (!done.changes)
			throw new AppError(409, 'Someone changed this plug meanwhile. Look again and retry.');
		this.onChange();
		return this.require(id);
	}

	remove(id: string) {
		this.require(id);
		this.db.delete(plugs).where(eq(plugs.id, id)).run();
		this.onChange();
	}
}
