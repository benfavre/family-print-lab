// Home automation: smart plugs that switch printers on before a print and off once they have cooled,
// outbound MQTT for the family's broker, read access for Home Assistant, and Prometheus metrics. All
// of it is off until someone sets it up in Integrations → Home automation.
import { count } from 'drizzle-orm';
import { defineModule, type ModuleContext } from '../../modules';
import type { PowerService, QueueService } from '../contracts';
import { jobs } from '../../db/schema';
import { AppError, parse } from '../../validation';
import { JOB_STATUSES, type JobStatus } from '$lib/shared/domain';
import type { HaPrinter, HomeAutomationView, PowerState } from '$lib/shared/home-automation';
import { PlugStore } from './store';
import { PowerController, type PowerTimings } from './power';
import { brokerKey, MqttOutput, testBroker } from './mqtt-out';
import { haPrinter, renderMetrics } from './export';
import { newToken } from './access';
import {
	DEFAULT_SETTINGS,
	mqttInput,
	settingsPatch,
	storedSettings,
	type StoredSettings
} from './validation';

export interface HomeAutomation extends PowerService {
	plugs: PlugStore;
	power: PowerController;
	settings(): StoredSettings;
	view(): HomeAutomationView;
	updateSettings(input: unknown): HomeAutomationView;
	/** A new token (shown once); the previous one stops working. */
	createToken(): string;
	revokeToken(): void;
	/** Connects to a broker once: the saved settings with `input` over them (a blank password keeps the saved one). */
	testMqtt(input?: unknown): Promise<{ ok: boolean; detail: string }>;
	powerStates(): PowerState[];
	haPrinters(): HaPrinter[];
	metrics(): string;
}

declare module '$lib/server/modules' {
	interface ModuleServices {
		'home-automation': HomeAutomation;
	}
}

declare module '$lib/server/events' {
	interface LabEventMap {
		/** A printer's smart plug was switched on or off by the app. */
		'power.on': { printerId: string; printerName: string; reason: 'auto' | 'manual' | 'print' };
		'power.off': { printerId: string; printerName: string; reason: 'auto' | 'manual' | 'print' };
	}
}

/** Test hook: shorter waits in integration tests (set before the module starts). */
export const timings: { override?: Partial<PowerTimings> } = {};

let stopAll: (() => void) | null = null;
let current: HomeAutomation | null = null;

function start(ctx: ModuleContext): HomeAutomation {
	const store = ctx.settings(storedSettings, DEFAULT_SETTINGS);
	const nameOf = (id: string) =>
		ctx.printers.get(id)?.name ?? ctx.lab.printers().find((p) => p.id === id)?.name ?? '';

	const power = new PowerController({
		plugFor: (id) => plugs.forPrinter(id),
		printer: (id) => ctx.printers.get(id),
		// Any item lined up for this printer may start soon (QueueService has no due time). The queue
		// package declares its ModuleServices entry itself, so it is looked up by name here.
		queueDue: (id) =>
			!!((ctx.module as (key: string) => unknown)('queue') as QueueService | undefined)?.nextFor(
				id
			),
		changed(state, what) {
			ctx.live.send('home-automation:power', state);
			if (what)
				ctx.bus.emit(what.on ? 'power.on' : 'power.off', {
					printerId: state.printerId,
					printerName: nameOf(state.printerId),
					reason: what.reason
				});
			if (what) output.printerChanged(state.printerId);
		},
		log: ctx.log,
		timings: timings.override
	});

	// The wake-up hook is there only while some plug switches its printer on by itself, so sends to a
	// printer that is off still say "not connected" straight away when nothing can wake it.
	let offHook: (() => void) | null = null;
	const syncHook = () => {
		const wanted = plugs.list().some((p) => p.autoOn);
		if (wanted && !offHook)
			offHook = ctx.hooks.beforeDispatch.add(({ printerId, signal }) =>
				power.ensureOn(printerId, { signal })
			);
		else if (!wanted && offHook) {
			offHook();
			offHook = null;
		}
	};
	const plugs = new PlugStore(ctx.db, () => {
		syncHook();
		void refresh();
	});

	const output = new MqttOutput({
		settings: () => store.get().mqtt,
		printers: () => ctx.printers.statuses(),
		power: (id) => power.state(id).on,
		log: ctx.log,
		onState: (state) => ctx.live.send('home-automation:mqtt', { state })
	});

	// Reads every plug that can be read, now and every minute, so the Power panel and metrics know.
	const refresh = async () => {
		for (const plug of plugs.list())
			if (plug.kind !== 'webhook') await power.read(plug.printerId).catch(() => {});
	};
	const poll = setInterval(() => void refresh(), 60_000);
	poll.unref?.();
	void refresh();

	const offs = [
		ctx.bus.on('print.finished', (e) => power.printEnded(e.printerId)),
		ctx.bus.on('print.failed', (e) => power.printEnded(e.printerId)),
		ctx.bus.on('print.cancelled', (e) => power.printEnded(e.printerId)),
		ctx.bus.on('print.started', (e) => power.cancelOff(e.printerId)),
		ctx.bus.onAny((e) => output.event(e.name, e.data))
	];
	const onUpdate = (id: string) => output.printerChanged(id);
	const onChanged = () => {
		output.printersChanged();
		syncHook();
	};
	ctx.printers.on('update', onUpdate);
	ctx.printers.on('changed', onChanged);
	syncHook();
	output.restart();

	stopAll = () => {
		clearInterval(poll);
		for (const off of offs) off();
		ctx.printers.off('update', onUpdate);
		ctx.printers.off('changed', onChanged);
		offHook?.();
		power.stop();
		output.stop();
	};

	const view = (): HomeAutomationView => {
		const s = store.get();
		const { password, ...mqtt } = s.mqtt;
		return {
			token: { hasToken: !!s.tokenHash, createdAt: s.tokenCreatedAt },
			ha: s.ha,
			metrics: s.metrics,
			mqtt: { ...mqtt, hasPassword: !!password, state: output.state }
		};
	};

	/**
	 * The saved MQTT settings with an input over them; a missing or empty password keeps the saved one,
	 * but only for the broker it was saved for (so it cannot be sent to another server).
	 */
	const mergeMqtt = (input: unknown): StoredSettings['mqtt'] => {
		const saved = store.get().mqtt;
		const v = parse(mqttInput, input ?? {});
		const { password, ...rest } = v;
		const defined = Object.fromEntries(Object.entries(rest).filter(([, x]) => x !== undefined));
		const next = { ...saved, ...defined };
		let kept = password === null ? '' : password ? password : saved.password;
		if (!password && kept) {
			if (!next.url) kept = '';
			else if (brokerKey(next.url) !== brokerKey(saved.url))
				throw new AppError(
					400,
					'The broker address changed, so enter its password again. A saved password only goes to the broker it was saved for.'
				);
		}
		return { ...next, password: kept };
	};

	const service: HomeAutomation = {
		plugs,
		power,
		ensureOn: (printerId, opts) => power.ensureOn(printerId, opts),
		settings: () => store.get(),
		view,
		updateSettings(input) {
			const v = parse(settingsPatch, input);
			const s = store.get();
			const mqtt = v.mqtt ? mergeMqtt(v.mqtt) : s.mqtt;
			if (mqtt.enabled && !mqtt.url) mqtt.enabled = false;
			store.set({
				...s,
				...(v.ha && { ha: v.ha }),
				...(v.metrics && { metrics: v.metrics }),
				mqtt
			});
			if (v.mqtt) output.restart();
			return view();
		},
		createToken() {
			const { token, hash } = newToken();
			store.set({ ...store.get(), tokenHash: hash, tokenCreatedAt: new Date().toISOString() });
			return token;
		},
		revokeToken() {
			store.set({ ...store.get(), tokenHash: null, tokenCreatedAt: null });
		},
		testMqtt: (input) => {
			const s = mergeMqtt(input);
			if (!s.url) return Promise.resolve({ ok: false, detail: 'Add the broker address first.' });
			return testBroker(s);
		},
		powerStates: () => plugs.list().map((p) => power.state(p.printerId)),
		haPrinters: () =>
			ctx.printers
				.statuses()
				.filter((p) => p.id)
				.map((p) => haPrinter(p, plugs.forPrinter(p.id!) ? power.state(p.id!).on : null)),
		metrics() {
			const counts = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<
				JobStatus,
				number
			>;
			for (const row of ctx.db
				.select({ status: jobs.status, n: count() })
				.from(jobs)
				.groupBy(jobs.status)
				.all())
				counts[row.status] = row.n;
			return renderMetrics({
				printers: ctx.printers.statuses().filter((p) => p.id),
				jobs: counts,
				power: Object.fromEntries(
					plugs.list().map((p) => [p.printerId, power.state(p.printerId).on])
				)
			});
		}
	};
	current = service;
	return service;
}

export default defineModule({
	key: 'home-automation',
	order: 60,
	start,
	stop() {
		stopAll?.();
		stopAll = null;
		current = null;
	},
	integrations() {
		const s = current?.settings();
		const plugs = current?.plugs.list().length ?? 0;
		const on = [
			plugs && `${plugs} smart plug${plugs === 1 ? '' : 's'}`,
			s?.mqtt.enabled && 'MQTT',
			s?.ha.enabled && 'Home Assistant',
			s?.metrics.enabled && 'metrics'
		].filter(Boolean) as string[];
		return [
			{
				id: 'home-automation',
				kind: 'module',
				name: 'Home automation',
				via: 'Smart plugs, MQTT, Home Assistant, Prometheus',
				available: on.length > 0,
				detail: on.length
					? `On: ${on.join(', ')}.`
					: 'Off. Nothing leaves this computer until you set it up.',
				powers: [
					'Switching printers on before a print and off once cool',
					'Printer status for Home Assistant and other home automation'
				],
				setup: [{ text: 'Open Integrations → Home automation, add a plug or turn on MQTT.' }]
			}
		];
	}
});
