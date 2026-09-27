// What home automation sees of the lab: a flat, sensor-friendly printer shape (Home Assistant REST and
// the MQTT status topic) and Prometheus metrics. Printer ids and names only: never serial numbers,
// access codes or addresses.
import type { PrinterStatus } from '$lib/shared/printers/status';
import type { HaPrinter } from '$lib/shared/home-automation';
import type { JobStatus } from '$lib/shared/domain';

const num = (n: number | null | undefined) =>
	typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 10) / 10 : null;

export function haPrinter(p: PrinterStatus, power: boolean | null = null): HaPrinter {
	const s = p.state ?? null;
	return {
		id: p.id ?? '',
		name: p.name ?? '',
		model: p.modelName ?? p.model ?? null,
		online: !!p.connected,
		state: !p.connected ? 'offline' : (s?.gcodeState ?? 'UNKNOWN').toLowerCase(),
		printing: !!p.printing,
		progress: num(s?.percent),
		remaining_minutes: num(s?.remainingMinutes),
		layer: s?.layer ?? null,
		total_layers: s?.totalLayers ?? null,
		task: s?.task || null,
		nozzle_temp: num(s?.nozzle),
		nozzle_target: num(s?.nozzleTarget),
		bed_temp: num(s?.bed),
		bed_target: num(s?.bedTarget),
		chamber_temp: num(s?.chamber),
		print_error: s?.printError ?? 0,
		hms_count: s?.hms.length ?? 0,
		ams: (s?.ams ?? []).map((u) => ({
			unit: u.unit,
			humidity_percent: num(u.humidityPercent),
			humidity_level: u.humidityIndex,
			temp: num(u.temp)
		})),
		power,
		updated_at: s?.lastReportAt ?? p.lastSeen ?? null
	};
}

/** Keys that never leave the lab, whatever event carries them. */
const PRIVATE_KEY =
	/^(serial|sn|dev_?id|access_?code|host|hostname|ip|address|url|password|token|secret)$/i;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g;
/** IPv6 literals: hex groups with at least two colons and either "::" or a hex letter (not a time). */
const IPV6 = /(?<![\w:])\[?(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?:\](?::\d+)?)?(?![\w:])/gi;

/**
 * Event data for home automation: private keys dropped and IP addresses blanked in text (a
 * connection error can quote the printer's address).
 */
export function scrub(value: unknown, depth = 0): unknown {
	if (typeof value === 'string')
		return value.replace(IPV4, '…').replace(IPV6, (m) => (/::|[a-f]/i.test(m) ? '…' : m));
	if (depth > 6 || value === null || typeof value !== 'object') return value;
	if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
	return Object.fromEntries(
		Object.entries(value)
			.filter(([k]) => !PRIVATE_KEY.test(k))
			.map(([k, v]) => [k, scrub(v, depth + 1)])
	);
}

// ---- Prometheus text exposition format 0.0.4 ----
// https://prometheus.io/docs/instrumenting/exposition_formats/#text-based-format

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** Label values escape backslash, double quote and line feed. */
const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

interface Sample {
	labels: Record<string, string>;
	value: number;
}

class Exposition {
	private out: string[] = [];
	metric(name: string, help: string, samples: Sample[], type: 'gauge' | 'counter' = 'gauge') {
		if (!samples.length) return;
		this.out.push(`# HELP ${name} ${help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`);
		this.out.push(`# TYPE ${name} ${type}`);
		for (const s of samples) {
			const labels = Object.entries(s.labels)
				.map(([k, v]) => `${k}="${esc(v)}"`)
				.join(',');
			const value = Number.isFinite(s.value)
				? String(s.value)
				: s.value > 0
					? '+Inf'
					: s.value < 0
						? '-Inf'
						: 'NaN';
			this.out.push(`${name}${labels ? `{${labels}}` : ''} ${value}`);
		}
	}
	toString() {
		return this.out.join('\n') + '\n';
	}
}

export function renderMetrics(o: {
	printers: PrinterStatus[];
	jobs: Record<JobStatus, number>;
	power: Record<string, boolean | null>;
}): string {
	const e = new Exposition();
	const who = (p: PrinterStatus) => ({
		printer_id: p.id ?? '',
		printer: p.name ?? '',
		model: p.model ?? ''
	});
	const each = (
		get: (p: PrinterStatus) => number | null | undefined,
		extra?: (p: PrinterStatus) => Record<string, string>
	) =>
		o.printers.flatMap((p) => {
			const v = get(p);
			return typeof v === 'number' && Number.isFinite(v)
				? [{ labels: { ...who(p), ...extra?.(p) }, value: v }]
				: [];
		});
	const live = (get: (p: PrinterStatus) => number | null | undefined) =>
		each((p) => (p.connected ? get(p) : null));

	e.metric(
		'printlab_printer_up',
		'Whether the app is connected to the printer (1) or not (0).',
		each((p) => (p.connected ? 1 : 0))
	);
	e.metric(
		'printlab_printer_state',
		'The printer state reported by the printer (1 for the current one).',
		each(
			(p) => (p.connected && p.state ? 1 : null),
			(p) => ({ state: (p.state?.gcodeState ?? 'UNKNOWN').toLowerCase() })
		)
	);
	e.metric(
		'printlab_printer_printing',
		'Whether a print is running, paused or preparing (1) or not (0).',
		live((p) => (p.printing ? 1 : 0))
	);
	e.metric(
		'printlab_print_progress_percent',
		'Progress of the current print, 0 to 100.',
		live((p) => (p.printing ? p.state?.percent : null))
	);
	e.metric(
		'printlab_print_remaining_seconds',
		'Estimated time left for the current print.',
		live((p) =>
			p.printing && p.state?.remainingMinutes != null ? p.state.remainingMinutes * 60 : null
		)
	);
	e.metric(
		'printlab_print_layer',
		'Current layer of the print.',
		live((p) => (p.printing ? p.state?.layer : null))
	);
	e.metric(
		'printlab_print_layers_total',
		'Layers in the current print.',
		live((p) => (p.printing ? p.state?.totalLayers : null))
	);
	e.metric(
		'printlab_nozzle_temperature_celsius',
		'Nozzle temperature.',
		o.printers.flatMap((p) =>
			p.connected && p.state
				? (p.state.nozzles.length
						? p.state.nozzles.map((n) => ({ id: n.id, temp: n.temp }))
						: [{ id: 0, temp: p.state.nozzle }]
					).flatMap((n) =>
						typeof n.temp === 'number'
							? [{ labels: { ...who(p), nozzle: String(n.id) }, value: n.temp }]
							: []
					)
				: []
		)
	);
	e.metric(
		'printlab_nozzle_target_celsius',
		'Nozzle target temperature.',
		o.printers.flatMap((p) =>
			p.connected && p.state
				? (p.state.nozzles.length
						? p.state.nozzles.map((n) => ({ id: n.id, target: n.target }))
						: [{ id: 0, target: p.state.nozzleTarget }]
					).flatMap((n) =>
						typeof n.target === 'number'
							? [{ labels: { ...who(p), nozzle: String(n.id) }, value: n.target }]
							: []
					)
				: []
		)
	);
	e.metric(
		'printlab_bed_temperature_celsius',
		'Bed temperature.',
		live((p) => p.state?.bed)
	);
	e.metric(
		'printlab_bed_target_celsius',
		'Bed target temperature.',
		live((p) => p.state?.bedTarget)
	);
	e.metric(
		'printlab_chamber_temperature_celsius',
		'Chamber temperature.',
		live((p) => p.state?.chamber)
	);
	e.metric(
		'printlab_hms_active',
		'Printer alerts (HMS) currently raised.',
		live((p) => p.state?.hms.length)
	);
	e.metric(
		'printlab_print_error',
		'Print error code reported by the printer (0 when none).',
		live((p) => p.state?.printError)
	);
	const ams = (get: (u: NonNullable<PrinterStatus['state']>['ams'][number]) => number | null) =>
		o.printers.flatMap((p) =>
			p.connected
				? (p.state?.ams ?? []).flatMap((u) => {
						const v = get(u);
						return typeof v === 'number' ? [{ labels: { ...who(p), ams: u.unit }, value: v }] : [];
					})
				: []
		);
	e.metric(
		'printlab_ams_humidity_percent',
		'Relative humidity inside the AMS unit.',
		ams((u) => u.humidityPercent)
	);
	e.metric(
		'printlab_ams_humidity_level',
		'AMS humidity level as the printer reports it (1 to 5).',
		ams((u) => u.humidityIndex)
	);
	e.metric(
		'printlab_ams_temperature_celsius',
		'Temperature inside the AMS unit.',
		ams((u) => u.temp)
	);
	e.metric(
		'printlab_plug_on',
		'Smart plug relay state (1 on, 0 off), for printers with a plug that can be read.',
		each((p) => {
			const on = o.power[p.id ?? ''];
			return on === true ? 1 : on === false ? 0 : null;
		})
	);
	e.metric(
		'printlab_jobs',
		'Print jobs by status.',
		(Object.entries(o.jobs) as [JobStatus, number][]).map(([status, n]) => ({
			labels: { status: status.toLowerCase() },
			value: n
		}))
	);
	return e.toString();
}
