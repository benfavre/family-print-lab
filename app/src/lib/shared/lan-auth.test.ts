import { describe, expect, it } from 'vitest';
import { deviceName } from './lan-auth';

describe('deviceName', () => {
	it('names common devices', () => {
		const cases: [string, string][] = [
			[
				'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
				'Safari on iPhone'
			],
			[
				'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36',
				'Chrome on Android'
			],
			[
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0',
				'Edge on Windows'
			],
			[
				'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0',
				'Firefox on Linux'
			],
			[
				'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) family-print-lab/2.1.5 Chrome/140.0 Electron/38.0 Safari/537.36',
				'Desktop app on Linux'
			],
			['curl/8.5.0', 'Unknown device'],
			['', 'Unknown device']
		];
		for (const [ua, name] of cases) expect(deviceName(ua)).toBe(name);
	});
});
