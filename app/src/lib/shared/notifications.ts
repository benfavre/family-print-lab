// Notifications: the in-app centre (the bell), desktop notifications and the opt-in channels that
// send messages out (ntfy, webhooks, Discord, Telegram, email). Shared by the server module and the UI.

export type NotifyLevel = 'info' | 'success' | 'warning' | 'error';

/** One entry in the notification centre. */
export interface NotificationItem {
	id: string;
	event: string;
	level: NotifyLevel;
	title: string;
	body: string;
	printerId: string | null;
	jobId: string | null;
	/** An in-app path, e.g. /printers/<id>. */
	link: string | null;
	createdAt: string;
	readAt: string | null;
}

export interface NotificationList {
	items: NotificationItem[];
	unread: number;
}

/** Placeholders templates may use. */
export const TEMPLATE_VARS = ['printer', 'task', 'job', 'percent', 'error', 'kid'] as const;
export type TemplateVar = (typeof TEMPLATE_VARS)[number];

export interface Template {
	title: string;
	body: string;
}

export interface NotifyEventDef {
	name: string;
	label: string;
	level: NotifyLevel;
	template: Template;
	/** On by default for new channels (the centre shows every event unless switched off). */
	channelDefault: boolean;
	/** The package that emits it, when it is not part of the lab itself. */
	module?: string;
}

/** Events people can be told about, in the order the settings show them. */
export const NOTIFY_EVENTS: NotifyEventDef[] = [
	{
		name: 'print.finished',
		label: 'Print finished',
		level: 'success',
		template: { title: '{{task}} is done', body: '{{printer}} finished printing {{job}}.' },
		channelDefault: true
	},
	{
		name: 'print.failed',
		label: 'Print failed',
		level: 'error',
		template: { title: '{{task}} failed', body: '{{printer}} stopped: {{error}}' },
		channelDefault: true
	},
	{
		name: 'print.cancelled',
		label: 'Print cancelled',
		level: 'warning',
		template: { title: '{{task}} was cancelled', body: '{{printer}} stopped at {{percent}}.' },
		channelDefault: false
	},
	{
		name: 'print.paused',
		label: 'Print paused',
		level: 'warning',
		template: { title: '{{task}} is paused', body: '{{printer}}: {{error}}' },
		channelDefault: true
	},
	{
		name: 'hms.raised',
		label: 'Printer alert',
		level: 'warning',
		template: { title: '{{printer}} needs attention', body: '{{error}}' },
		channelDefault: true
	},
	{
		name: 'ams.runout',
		label: 'Filament ran out',
		level: 'warning',
		template: {
			title: '{{printer}} ran out of filament',
			body: 'Load a new spool to carry on with {{task}}.'
		},
		channelDefault: true
	},
	{
		name: 'printer.offline',
		label: 'Printer offline',
		level: 'warning',
		template: {
			title: '{{printer}} is offline',
			body: 'It has not answered for 2 minutes. {{error}}'
		},
		channelDefault: false
	},
	{
		name: 'request.created',
		label: 'A kid asked to print',
		level: 'info',
		template: { title: '{{kid}} asked to print', body: '{{kid}} would like to print {{job}}.' },
		channelDefault: true
	},
	{
		name: 'queue.held',
		label: 'Queue held a job',
		level: 'warning',
		template: { title: 'A queued print is waiting', body: '{{job}} on {{printer}}: {{error}}' },
		channelDefault: false,
		module: 'queue'
	},
	{
		name: 'queue.dispatched',
		label: 'Queue started a job',
		level: 'info',
		template: { title: '{{job}} is on its way', body: 'The queue sent {{job}} to {{printer}}.' },
		channelDefault: false,
		module: 'queue'
	},
	{
		name: 'maintenance.due',
		label: 'Maintenance due',
		level: 'info',
		template: { title: '{{printer}}: maintenance due', body: '{{task}}' },
		channelDefault: true,
		module: 'maintenance'
	},
	{
		name: 'vision.alert',
		label: 'AI check spotted a problem',
		level: 'error',
		template: { title: '{{printer}}: check the print', body: '{{error}}' },
		channelDefault: true,
		module: 'ai-vision'
	},
	{
		name: 'other',
		label: 'Other messages from add-ons',
		level: 'info',
		template: { title: '', body: '' },
		channelDefault: false
	}
];

export const eventDef = (name: string) => NOTIFY_EVENTS.find((e) => e.name === name);

export type ChannelKind = 'desktop' | 'ntfy' | 'webhook' | 'discord' | 'telegram' | 'email';

export interface ChannelKindInfo {
	kind: ChannelKind;
	label: string;
	/** Sends to a third party (the setup says so). */
	external: boolean;
	/** Can attach a camera snapshot. */
	pictures: boolean;
}

export const CHANNEL_KINDS: ChannelKindInfo[] = [
	{ kind: 'desktop', label: 'This computer', external: false, pictures: false },
	{ kind: 'ntfy', label: 'ntfy', external: true, pictures: true },
	{ kind: 'webhook', label: 'Webhook', external: true, pictures: false },
	{ kind: 'discord', label: 'Discord', external: true, pictures: true },
	{ kind: 'telegram', label: 'Telegram', external: true, pictures: true },
	{ kind: 'email', label: 'Email', external: true, pictures: true }
];

export const channelKind = (kind: ChannelKind) => CHANNEL_KINDS.find((k) => k.kind === kind)!;

export interface QuietHours {
	enabled: boolean;
	/** 'HH:MM', local time on this computer. */
	from: string;
	to: string;
}

/** Bambu HMS severity, most serious first (`code >> 16`: 1 fatal, 2 serious, 3 common, 4 info). */
export const HMS_SEVERITIES = ['fatal', 'serious', 'common', 'info'] as const;
export type HmsSeverityName = (typeof HMS_SEVERITIES)[number];

export interface ChannelCommon {
	id: string;
	kind: ChannelKind;
	name: string;
	enabled: boolean;
	/** Event names this channel sends. */
	events: string[];
	quiet: QuietHours;
	/** Attach a camera picture when the printer has a camera. */
	snapshots: boolean;
	/** Printer alerts at this severity or worse. */
	hmsSeverity: HmsSeverityName;
}

/** Channel settings as the browser sees them: secrets are never sent back, only whether one is set. */
export type ChannelView = ChannelCommon &
	(
		| { kind: 'desktop' }
		| { kind: 'ntfy'; server: string; topic: string; hasToken: boolean }
		| { kind: 'webhook'; url: string; hasSecret: boolean }
		| { kind: 'discord'; hasUrl: boolean }
		| { kind: 'telegram'; chatId: string; hasToken: boolean }
		| {
				kind: 'email';
				host: string;
				port: number;
				security: 'tls' | 'starttls';
				user: string;
				from: string;
				to: string;
				hasPassword: boolean;
		  }
	) & { last: DeliveryResult | null };

export interface DeliveryResult {
	at: string;
	ok: boolean;
	detail: string;
}

export interface NotificationSettingsView {
	/** Events the centre (the bell) records. */
	inApp: string[];
	/** Edited templates by event name (defaults are in NOTIFY_EVENTS). */
	templates: Record<string, Template>;
	/** Pictures of kids' prints may be attached. */
	kidPictures: boolean;
	channels: ChannelView[];
	/** Running inside the desktop app, so "This computer" notifications work. */
	desktopAvailable: boolean;
	/** Event names whose package is installed (the others never fire). */
	present: string[];
}

export const DEFAULT_QUIET: QuietHours = { enabled: false, from: '22:00', to: '07:00' };
export const DEFAULT_NTFY_SERVER = 'https://ntfy.sh';
