// "A runtime with simulated printers" for integration tests: the real runtime over an in-memory SQLite
// database (migrations applied), a simulated fleet on free ports registered as printers (plain MQTT and
// FTP on 127.0.0.1), and a helper to wait for bus events. Ports come from binding port 0, so vitest
// workers can run in parallel.
import { bootRuntime, type Runtime } from '../runtime';
import { createFleet, type Fleet } from '../printer/sim/fleet';
import type { SimFeature, SimPrinter } from '../printer/sim/core';
import type { ServerModule } from '../modules';
import type { LabEventMap, LabEventName } from '../events';
import type { ModelCode } from '$lib/shared/printers/models';
import type { PrinterInfo } from '$lib/shared/printers/info';

export interface TestLab {
	rt: Runtime;
	fleet: Fleet;
	/** The first simulated printer of that model, with its saved row. */
	printer(model: ModelCode): { info: PrinterInfo; sim: SimPrinter };
	/** Resolves when the bus has emitted `name` (optionally matching `where`), rejects after `ms`. */
	nextEvent<K extends LabEventName>(
		name: K,
		where?: (d: LabEventMap[K]) => boolean,
		ms?: number
	): Promise<LabEventMap[K]>;
	stop(): Promise<void>;
}

export async function startTestLab(
	o: {
		/** Default ['N6']. */
		fleet?: ModelCode[];
		/** Module keys to start (default: all found by the glob; [] = none). */
		modules?: string[];
		/** Modules beyond the ones in modules/ (fixtures). */
		extraModules?: ServerModule[];
		/** Extra simulator features. */
		features?: SimFeature[];
		env?: Record<string, string>;
		/** Simulator time factor, default 60. */
		speed?: number;
	} = {}
): Promise<TestLab> {
	const fleet = await createFleet({
		printers: (o.fleet ?? ['N6']).map((model) => ({
			model,
			speed: o.speed ?? 60,
			failRate: 0,
			log: () => {},
			features: o.features
		}))
	});
	const rt = bootRuntime({
		env: {
			DATABASE_URL: ':memory:',
			LAB_AI: 'off',
			LEGACY_IMPORT: '/nonexistent/legacy.json',
			CLAUDE_BIN: '/nonexistent/claude',
			CODEX_BIN: '/nonexistent/codex',
			PRINTLAB_PRINTERS: fleet.env(),
			...o.env
		},
		modules: o.modules,
		extraModules: o.extraModules,
		log: () => {}
	});
	// Every printer connected and reporting.
	const deadline = Date.now() + 5000;
	while (
		Date.now() < deadline &&
		!rt.printers.list().every((p) => p.connected && p.snapshot && p.versions.length)
	)
		await new Promise((r) => setTimeout(r, 20));
	return {
		rt,
		fleet,
		printer(model) {
			const sim = fleet.printers.find((p) => p.sim.model.code === model)?.sim;
			if (!sim) throw new Error(`No simulated ${model} in this test lab.`);
			const info = rt.printers.info().find((p) => p.serial === sim.serial)!;
			return { info, sim: sim.sim };
		},
		nextEvent(name, where, ms = 10_000) {
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					off();
					reject(new Error(`No ${name} event within ${ms} ms.`));
				}, ms);
				const off = rt.bus.on(name, (data) => {
					if (where && !where(data)) return;
					clearTimeout(timer);
					off();
					resolve(data);
				});
			});
		},
		async stop() {
			await rt.close();
			await fleet.close();
		}
	};
}
