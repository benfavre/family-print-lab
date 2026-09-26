// Live channels: push updates a package's own page needs (camera state, queue order, notification
// count), sent by server modules with ctx.live.send('<module>:<name>', data) and relayed by
// /api/events as `event: live`. Not for bulk data. Use through lab.onLive(channel, fn).
type Listener = (data: unknown) => void;

export class LiveChannels {
	private listeners = new Map<string, Set<Listener>>();

	/** Subscribes to one channel; returns the unsubscribe function. */
	on<T>(channel: string, fn: (data: T) => void): () => void {
		const set = this.listeners.get(channel) ?? new Set<Listener>();
		set.add(fn as Listener);
		this.listeners.set(channel, set);
		return () => {
			set.delete(fn as Listener);
			if (!set.size) this.listeners.delete(channel);
		};
	}

	/** Called by the event stream for each `live` event. */
	dispatch(message: { channel?: unknown; data?: unknown }) {
		if (typeof message?.channel !== 'string') return;
		for (const fn of [...(this.listeners.get(message.channel) ?? [])])
			try {
				fn(message.data);
			} catch (error) {
				console.error(error);
			}
	}
}

/** The page-wide channels (LabStore uses this one). */
export const live = new LiveChannels();

export function onLive<T>(channel: string, fn: (data: T) => void): () => void {
	return live.on(channel, fn);
}
