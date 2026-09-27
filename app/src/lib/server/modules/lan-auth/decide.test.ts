import { describe, expect, it } from 'vitest';
import {
	authDecision,
	exposedBy,
	isLocalRequest,
	isLoopbackAddress,
	type AuthDecision
} from './decide';

describe('where a request comes from', () => {
	it('knows loopback addresses, IPv4-mapped too', () => {
		for (const ip of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1'])
			expect(isLoopbackAddress(ip)).toBe(true);
		for (const ip of [
			'192.168.1.20',
			'10.0.0.1',
			'::ffff:192.168.1.2',
			'fe80::1',
			'',
			'127.0.0.1.evil'
		])
			expect(isLoopbackAddress(ip)).toBe(false);
	});

	it('is local only from a loopback address that also names this computer', () => {
		expect(isLocalRequest('127.0.0.1', 'localhost')).toBe(true);
		expect(isLocalRequest('::1', '[::1]')).toBe(true);
		// A proxy on this computer forwarding for a LAN name, or a LAN device spoofing Host: localhost.
		expect(isLocalRequest('127.0.0.1', 'printlab.local')).toBe(false);
		expect(isLocalRequest('192.168.1.20', 'localhost')).toBe(false);
	});

	it('says why the app is reachable from other devices', () => {
		expect(exposedBy({})).toBeNull();
		expect(exposedBy({ HOST: '127.0.0.1', ALLOWED_HOSTS: 'localhost' })).toBeNull();
		expect(exposedBy({ HOST: '0.0.0.0' })).toBe('HOST=0.0.0.0');
		expect(exposedBy({ HOST: '127.0.0.1', ALLOWED_HOSTS: 'printlab.local, 192.168.1.20' })).toBe(
			'ALLOWED_HOSTS=printlab.local,192.168.1.20'
		);
	});
});

describe('who needs to log in', () => {
	const off = { hasPassword: false, requireLocal: false };
	const password = { hasPassword: true, requireLocal: false };
	const everywhere = { hasPassword: true, requireLocal: true };
	type Row = [
		string,
		{ local: boolean; session: boolean; settings: typeof off | null; pathname: string },
		AuthDecision
	];
	const rows: Row[] = [
		// This computer: open by default, whatever the path.
		['local, off, page', { local: true, session: false, settings: off, pathname: '/' }, 'allow'],
		[
			'local, off, API',
			{ local: true, session: false, settings: off, pathname: '/api/events' },
			'allow'
		],
		[
			'local, password',
			{ local: true, session: false, settings: password, pathname: '/jobs' },
			'allow'
		],
		[
			'local, require here too',
			{ local: true, session: false, settings: everywhere, pathname: '/' },
			'login'
		],
		[
			'local, require here too, API',
			{ local: true, session: false, settings: everywhere, pathname: '/api/workspace' },
			'login'
		],
		[
			'local, require here too, login page',
			{ local: true, session: false, settings: everywhere, pathname: '/login' },
			'allow'
		],
		[
			'local, require here too, session',
			{ local: true, session: true, settings: everywhere, pathname: '/' },
			'allow'
		],
		['local, module off', { local: true, session: false, settings: null, pathname: '/' }, 'allow'],
		// Other devices: always a session; until there is a password, the setup page.
		['LAN, off, page', { local: false, session: false, settings: off, pathname: '/' }, 'setup'],
		[
			'LAN, off, login page',
			{ local: false, session: false, settings: off, pathname: '/login' },
			'setup'
		],
		[
			'LAN, off, login call',
			{ local: false, session: false, settings: off, pathname: '/api/auth/login' },
			'setup'
		],
		[
			'LAN, password, page',
			{ local: false, session: false, settings: password, pathname: '/projects' },
			'login'
		],
		[
			'LAN, password, SSE',
			{ local: false, session: false, settings: password, pathname: '/api/events' },
			'login'
		],
		[
			'LAN, password, kid page',
			{ local: false, session: false, settings: password, pathname: '/kid' },
			'login'
		],
		[
			'LAN, password, login page',
			{ local: false, session: false, settings: password, pathname: '/login' },
			'allow'
		],
		[
			'LAN, password, login call',
			{ local: false, session: false, settings: password, pathname: '/api/auth/login' },
			'allow'
		],
		[
			'LAN, password, auth status',
			{ local: false, session: false, settings: password, pathname: '/api/auth' },
			'login'
		],
		[
			'LAN, password, session',
			{ local: false, session: true, settings: password, pathname: '/api/workspace' },
			'allow'
		],
		[
			'LAN, module off',
			{ local: false, session: false, settings: null, pathname: '/' },
			'unavailable'
		]
	];
	it.each(rows)('%s', (_, input, expected) => {
		expect(authDecision(input)).toBe(expected);
	});
});
