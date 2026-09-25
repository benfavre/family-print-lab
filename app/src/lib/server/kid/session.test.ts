import { describe, expect, it } from 'vitest';
import { kidAccess } from './session';

describe('kid mode access', () => {
	it('keeps kid browsers on kid pages', () => {
		expect(kidAccess('GET', '/kid', '/kid')).toBe('allow');
		expect(kidAccess('GET', '/kid/make/name-sign', '/kid/make/[template]')).toBe('allow');
		for (const [path, route] of [
			['/', '/'],
			['/jobs', '/jobs'],
			['/printer', '/printer'],
			['/family', '/family'],
			['/projects/x', '/projects/[id]'],
			['/kidnapped', '/kidnapped']
		])
			expect(kidAccess('GET', path, route)).toBe('redirect');
	});

	it('lets built assets through', () => {
		expect(kidAccess('GET', '/_app/immutable/x.js', null)).toBe('allow');
		expect(kidAccess('GET', '/fonts/Geist-Variable.woff2', null)).toBe('allow');
	});

	it('allows only the API the kid pages need', () => {
		expect(kidAccess('POST', '/api/kid/things', null)).toBe('allow');
		expect(kidAccess('GET', '/api/events', null)).toBe('allow');
		expect(kidAccess('GET', '/api/models/m/versions/v/model.stl', null)).toBe('allow');
		expect(kidAccess('PUT', '/api/models/m/versions/v/thumbnail.png', null)).toBe('allow');
		expect(kidAccess('PUT', '/api/models/m/versions/v/thumbnail.webp', null)).toBe('allow');
		expect(kidAccess('HEAD', '/api/models/m/versions/v/thumbnail.webp', null)).toBe('allow');
		for (const [method, path] of [
			['PUT', '/api/models/m/versions/v/model.stl'],
			['GET', '/api/models/m/versions/v/model.3mf'],
			['POST', '/api/printer/control'],
			['POST', '/api/profiles'],
			['PATCH', '/api/profiles/p'],
			['DELETE', '/api/projects/p'],
			['GET', '/api/export'],
			['GET', '/api/backups'],
			['POST', '/api/ai'],
			['POST', '/api/requests/r'],
			['POST', '/api/parent/pin'],
			['POST', '/api/cloud/link'],
			['POST', '/api/cloud/unlink'],
			['PATCH', '/api/cloud'],
			['GET', '/api/kidnapped']
		])
			expect(kidAccess(method, path, null), `${method} ${path}`).toBe('refuse');
	});
});
