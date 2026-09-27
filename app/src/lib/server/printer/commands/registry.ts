// The typed printer command layer. Each command is a definition (defs/*.ts) that names its MQTT topic,
// cites where its payload is documented, validates its parameters, says which capabilities it needs
// and when to refuse, and builds the message body. BambuPrinter.send() runs them. Packages add
// commands by adding defs/<key>.ts and declaring their params here by declaration merging:
//
//   declare module '../registry' {
//   	interface CommandMap {
//   		'print.print_speed': { level: SpeedLevel };
//   	}
//   }
//
// Names are `<topic>.<command>`, or `<topic>.<command>:<variant>` when several defs send the same
// firmware command (for example `print.gcode_line:set_nozzle_temp`), so two packages never collide.
import type { z } from 'zod';
import type { Capabilities, PrinterModel } from '$lib/shared/printers/models';
import type { PrinterSnapshot } from '$lib/shared/printers/status';
import type { ProjectFileParams } from './defs/core';

/** Every command's params, by name. */
export interface CommandMap {
	'pushing.pushall': Record<string, never>;
	'info.get_version': Record<string, never>;
	'print.project_file': ProjectFileParams;
	'print.pause': Record<string, never>;
	'print.resume': Record<string, never>;
	'print.stop': Record<string, never>;
	'print.gcode_line': { lines: string[]; allowEmergency?: boolean };
}
export type CommandName = keyof CommandMap;
export type Topic = 'print' | 'system' | 'info' | 'pushing' | 'camera' | 'xcam' | 'upgrade';

export interface CommandContext {
	printerId: string;
	model: PrinterModel;
	caps: Capabilities;
	status: PrinterSnapshot | null;
	firmware: string | null;
}

export interface CommandDef<N extends CommandName = CommandName> {
	name: N;
	topic: Topic;
	/** Where the payload is documented; shown in code review, not to users. */
	source: string;
	params: z.ZodType<CommandMap[N]>;
	/** Capabilities that must all be true (checked before guard). */
	requires?: (keyof Capabilities)[];
	/** Plain-words reason to refuse, or null. Runs after params are parsed. */
	guard?: (ctx: CommandContext, params: CommandMap[N]) => string | null;
	/** Body under `topic`, without sequence_id; must include `command`. */
	build: (params: CommandMap[N], ctx: CommandContext) => Record<string, unknown>;
	/** Resolve 'confirmed' early when live status shows the effect. */
	settled?: (status: PrinterSnapshot, params: CommandMap[N]) => boolean;
	/** 'wait': resolve on the matching reply (default); 'none': resolve 'sent' once published. */
	reply?: 'wait' | 'none';
	/** Default 10000; on timeout resolve 'sent' (some firmware never answers). */
	timeoutMs?: number;
	/** Default 0; pause/resume/stop use 1. */
	qos?: 0 | 1;
	/** UI hint: 'safe' (one tap), 'confirm' (ConfirmDialog), 'parent' (confirm + never in kid mode). */
	risk: 'safe' | 'confirm' | 'parent';
	/**
	 * Only the app itself sends it (BambuPrinter's own timing and checks); POST
	 * /api/printers/[id]/commands refuses it. `risk` is only a UI hint, so this is what keeps the
	 * unguarded raw forms out of HTTP.
	 */
	internal?: true;
}

export interface CommandOutcome {
	outcome: 'confirmed' | 'sent';
	/** The printer's reply body when there was one (topic object, e.g. get_version's `module`). */
	reply?: Record<string, unknown>;
}

export function defineCommand<N extends CommandName>(def: CommandDef<N>): CommandDef<N> {
	return def;
}

const files = import.meta.glob<{ default: CommandDef[] }>(['./defs/*.ts', '!./defs/*.test.ts'], {
	eager: true
});
let registry: Map<string, CommandDef> | null = null;
/** Built on first use: the defs import this file, so reading them at load time would be circular. */
function commands() {
	if (registry) return registry;
	const map = new Map<string, CommandDef>();
	for (const [file, mod] of Object.entries(files))
		for (const def of mod.default ?? []) {
			if (map.has(def.name))
				throw new Error(`Printer command ${def.name} is defined twice (again in ${file}).`);
			map.set(def.name, def as CommandDef);
		}
	return (registry = map);
}

export function commandDef(name: string): CommandDef | undefined {
	return commands().get(name);
}

export function allCommands(): CommandDef[] {
	return [...commands().values()];
}

/**
 * Whether a printer's reply means it did the thing: a missing `result` counts as success, strings are
 * compared case-insensitively ("success", "SUCCESS", "ok"), and a numeric non-zero `result` or
 * `err_code` is a failure (camera replies use numbers; ClusterM research/06.02-mqtt.md).
 */
export function replyFailed(reply: Record<string, unknown>): string | null {
	const result = reply.result;
	const reason =
		(typeof reply.reason === 'string' && reply.reason) ||
		(typeof reply.err_msg === 'string' && reply.err_msg) ||
		'';
	if (typeof reply.err_code === 'number' && reply.err_code !== 0)
		return reason || `error ${reply.err_code}`;
	if (result === undefined || result === null || result === '') return null;
	if (typeof result === 'number') return result === 0 ? null : reason || `error ${result}`;
	const r = String(result).toLowerCase();
	return r === 'success' || r === 'ok' ? null : reason || r;
}
