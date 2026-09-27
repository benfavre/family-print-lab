// Every printer command reaches exactly one simulator feature. The simulator stops at the first
// feature that answers, so a second handler for the same command would never run.
import { describe, expect, it } from 'vitest';
import { createSimulator } from '../core';
import { FEATURES } from '.';
import { allCommands, type CommandContext } from '../../commands/registry';
import commandsGolden from '../../commands/commands.golden.json';
import controlsGolden from '../../commands/defs/controls.golden.json';
import { PRINTER_MODELS, capabilitiesFor } from '$lib/shared/printers/models';
import { emptySnapshot } from '$lib/shared/printers/status';
import { parse } from '../../../validation';

const golden = new Map<string, Record<string, unknown>>(
	[...commandsGolden, ...controlsGolden].map((g) => [g.name, g.params as Record<string, unknown>])
);
const ctx: CommandContext = {
	printerId: 'p',
	model: PRINTER_MODELS.N6,
	caps: capabilitiesFor('N6', null),
	status: emptySnapshot({}),
	firmware: null
};

/** The distinct topic.command pairs the registered defs send. */
function sentCommands() {
	const out = new Map<string, { topic: string; body: Record<string, unknown> }>();
	for (const def of allCommands()) {
		let body: Record<string, unknown>;
		try {
			const params = parse(def.params, golden.get(def.name) ?? {});
			body = def.build(params as never, ctx);
		} catch {
			continue;
		}
		out.set(`${def.topic}.${String(body.command)}`, { topic: def.topic, body });
	}
	return out;
}

describe('simulator features', () => {
	it('answers each printer command in one feature only', () => {
		const sent = sentCommands();
		expect(sent.has('print.ams_control')).toBe(true);
		for (const [name, { topic, body }] of sent) {
			const answered = FEATURES.filter((f) => {
				if (!f.command) return false;
				const { sim } = createSimulator({ model: 'N6', log: () => {} });
				try {
					return f.command(sim, topic, { ...body, sequence_id: '1' }) !== undefined;
				} catch {
					return true;
				}
			}).map((f) => f.key);
			expect(answered.length, `${name}: ${answered.join(', ')}`).toBeLessThanOrEqual(1);
		}
	});

	it('resumes a print paused by an AMS runout on ams_control', () => {
		const { sim } = createSimulator({ model: 'N6', log: () => {} });
		const s = sim.state;
		s.gcode_state = 'PAUSE';
		s.hms = [{ attr: 0x07002000, code: 0x00020001 }];
		s.print_error = 0x07008011;
		let answer;
		for (const f of FEATURES) {
			answer = f.command?.(sim, 'print', { command: 'ams_control', param: 'resume' });
			if (answer !== undefined) break;
		}
		expect(answer).toEqual({ result: 'success' });
		expect(s.gcode_state).toBe('RUNNING');
		expect(s.hms).toEqual([]);
		expect(s.print_error).toBe(0);
	});
});
