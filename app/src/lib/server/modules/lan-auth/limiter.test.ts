import { describe, expect, it } from 'vitest';
import { RateLimiter } from './limiter';

const MIN = 60_000;

function limiter(o: ConstructorParameters<typeof RateLimiter>[0] = {}) {
	const clock = { now: 0 };
	return { clock, l: new RateLimiter({ now: () => clock.now, ...o }) };
}

describe('RateLimiter', () => {
	it('allows 4 wrong tries, locks for 5 minutes on the fifth', () => {
		const { clock, l } = limiter();
		for (let i = 0; i < 4; i++) expect(l.fail('ip:a')).toBe(0);
		expect(l.wait('ip:a')).toBe(0);
		expect(l.fail('ip:a')).toBe(5 * MIN);
		clock.now += 2 * MIN;
		expect(l.wait('ip:a')).toBe(3 * MIN);
		clock.now += 3 * MIN;
		expect(l.wait('ip:a')).toBe(0);
	});

	it('only counts tries within the 5-minute window', () => {
		const { clock, l } = limiter();
		for (let i = 0; i < 4; i++) l.fail('k');
		clock.now += 5 * MIN;
		expect(l.fail('k')).toBe(0);
	});

	it('doubles each lockout up to the cap, and forgets after a quiet day', () => {
		const { clock, l } = limiter({ maxLockMs: 30 * MIN });
		const strike = () => {
			for (let i = 0; i < 4; i++) l.fail('k');
			const locked = l.fail('k');
			clock.now += locked;
			return locked / MIN;
		};
		expect([strike(), strike(), strike(), strike()]).toEqual([5, 10, 20, 30]);
		clock.now += 25 * 60 * MIN;
		expect(strike()).toBe(5);
	});

	it('keeps keys apart, and reset forgets one', () => {
		const { l } = limiter();
		for (let i = 0; i < 5; i++) l.fail('ip:a');
		expect(l.wait('ip:b')).toBe(0);
		l.reset('ip:a');
		expect(l.wait('ip:a')).toBe(0);
	});
});
