// Home automation as the browser sees it: smart plugs per printer, the MQTT output, the Home Assistant
// token and the Prometheus metrics switch. Passwords and tokens never come back from the server; the
// views say `hasPassword` / `hasToken` instead.

export const PLUG_KINDS = ['tasmota', 'shelly', 'shelly-rpc', 'homeassistant', 'webhook'] as const;
export type PlugKind = (typeof PLUG_KINDS)[number];

export const PLUG_KIND_NAME: Record<PlugKind, string> = {
	tasmota: 'Tasmota',
	shelly: 'Shelly (first generation)',
	'shelly-rpc': 'Shelly Plus, Pro or newer',
	homeassistant: 'Home Assistant switch',
	webhook: 'Web addresses (webhooks)'
};

/** A plug's settings without its secrets. */
export interface PlugConfigView {
	/** Device or Home Assistant address, e.g. http://192.168.1.30 (not webhooks). */
	url?: string;
	/** Tasmota and first-generation Shelly logins. */
	user?: string;
	/** Relay or switch number on multi-channel devices (Shelly), default 0. */
	channel?: number;
	/** Home Assistant entity, e.g. switch.printer_plug. */
	entityId?: string;
	/** Webhooks. */
	onUrl?: string;
	offUrl?: string;
	method?: 'GET' | 'POST';
	hasPassword: boolean;
	hasToken: boolean;
}

export interface PlugInfo {
	id: string;
	printerId: string;
	kind: PlugKind;
	config: PlugConfigView;
	autoOn: boolean;
	autoOff: boolean;
	cooldownMinutes: number;
	offBelowNozzle: number;
	version: number;
	createdAt: string;
	updatedAt: string;
}

/** What the app knows about a plug right now (sent on the `home-automation:power` live channel). */
export interface PowerState {
	printerId: string;
	/** Last known relay state; null when the plug cannot be read back (webhooks) or has not answered. */
	on: boolean | null;
	/** "Switching on…", "Off in 4 min once cool", a failure… in plain words; '' when idle. */
	note: string;
	/** ISO time of the last change the app made or saw. */
	at: string | null;
}

export interface HomeAutomationView {
	/** One token for Home Assistant's REST access and remote /metrics; only its hash is stored. */
	token: { hasToken: boolean; createdAt: string | null };
	ha: { enabled: boolean };
	metrics: { enabled: boolean };
	mqtt: {
		enabled: boolean;
		url: string;
		username: string;
		hasPassword: boolean;
		topicPrefix: string;
		discovery: boolean;
		discoveryPrefix: string;
		/** Check the broker's certificate (mqtts only). */
		verifyTls: boolean;
		/** 'off' | 'connecting' | 'connected' | the last error. */
		state: string;
	};
}

/** The flat, sensor-friendly printer shape of GET /api/ha/printers and the MQTT status topic. */
export interface HaPrinter {
	id: string;
	name: string;
	model: string | null;
	online: boolean;
	state: string;
	printing: boolean;
	progress: number | null;
	remaining_minutes: number | null;
	layer: number | null;
	total_layers: number | null;
	task: string | null;
	nozzle_temp: number | null;
	nozzle_target: number | null;
	bed_temp: number | null;
	bed_target: number | null;
	chamber_temp: number | null;
	print_error: number;
	hms_count: number;
	ams: {
		unit: string;
		humidity_percent: number | null;
		humidity_level: number | null;
		temp: number | null;
	}[];
	/** The smart plug, when there is one. */
	power: boolean | null;
	updated_at: string | null;
}
