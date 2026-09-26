import { describe, expect, it } from 'vitest';
import { LiveChannels } from './live';

describe('live channels', () => {
	it('delivers only to the named channel, until unsubscribed, and ignores junk', () => {
		const live = new LiveChannels();
		const got: unknown[] = [];
		const off = live.on<{ n: number }>('queue:order', (d) => got.push(d.n));
		live.on('camera:state', () => got.push('camera'));
		live.dispatch({ channel: 'queue:order', data: { n: 1 } });
		live.dispatch({ channel: 42, data: {} } as never);
		off();
		live.dispatch({ channel: 'queue:order', data: { n: 2 } });
		expect(got).toEqual([1]);
	});
});
