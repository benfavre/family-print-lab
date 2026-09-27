// Which channels a message goes to (pure): the channel is on, wants this event, the alert is serious
// enough, and it is not quiet hours there. Pictures only where allowed.
import {
	channelKind,
	eventDef,
	HMS_SEVERITIES,
	type HmsSeverityName,
	type QuietHours
} from '$lib/shared/notifications';
import type { Message } from './messages';
import type { StoredChannel } from './validation';

const minutes = (hhmm: string) => {
	const [h, m] = hhmm.split(':').map(Number);
	return h * 60 + m;
};

/** Local time on this computer; a range like 22:00–07:00 crosses midnight. */
export function inQuietHours(q: QuietHours, now: Date): boolean {
	if (!q.enabled || q.from === q.to) return false;
	const at = now.getHours() * 60 + now.getMinutes();
	const from = minutes(q.from);
	const to = minutes(q.to);
	return from < to ? at >= from && at < to : at >= from || at < to;
}

/** The event name a channel's toggles use (anything outside the catalogue is "other"). */
export const toggleName = (event: string) => (eventDef(event) ? event : 'other');

/** Alerts of unknown severity count as common. */
export function severeEnough(
	severity: HmsSeverityName | 'unknown' | null,
	threshold: HmsSeverityName
): boolean {
	const rank = (s: HmsSeverityName) => HMS_SEVERITIES.indexOf(s);
	return rank(!severity || severity === 'unknown' ? 'common' : severity) <= rank(threshold);
}

export function wants(channel: StoredChannel, message: Message, now: Date): boolean {
	if (!channel.enabled || !channel.events.includes(toggleName(message.event))) return false;
	if (message.event === 'hms.raised' && !severeEnough(message.hmsSeverity, channel.hmsSeverity))
		return false;
	return !inQuietHours(channel.quiet, now);
}

/** A camera picture goes along only when the channel asks, supports it, and a kid's print is allowed. */
export function wantsPicture(
	channel: StoredChannel,
	message: Message,
	kidPictures: boolean
): boolean {
	return (
		channel.snapshots &&
		channelKind(channel.kind).pictures &&
		!!message.printerId &&
		(!message.kidJob || kidPictures)
	);
}
