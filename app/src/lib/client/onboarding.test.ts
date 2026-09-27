import { describe, expect, it } from 'vitest';
import { CLOUD_OFF } from '$lib/shared/cloud';
import type { IntegrationStatus } from '$lib/shared/integrations';
import { cloudIntegration, groupIntegrations, integrationGroup, trustLine } from './onboarding';

const row = (id: string, kind: IntegrationStatus['kind'] = 'module'): IntegrationStatus => ({
	id,
	kind,
	name: id,
	via: '',
	available: true,
	detail: '',
	powers: [],
	setup: []
});

describe('integration groups', () => {
	it('puts known rows in their group and unknown module rows under More', () => {
		expect(integrationGroup(row('claude-code', 'ai'))).toBe('ai');
		expect(integrationGroup(row('slicer'))).toBe('making');
		expect(integrationGroup(row('printer', 'printer'))).toBe('printers');
		expect(integrationGroup(row('camera'))).toBe('printers');
		expect(integrationGroup(row('notifications'))).toBe('home');
		expect(integrationGroup(row('ai-vision'))).toBe('more');
	});

	it('keeps group order and item order, and drops empty groups', () => {
		const groups = groupIntegrations([
			row('notifications'),
			row('codex', 'ai'),
			row('blender', 'tool'),
			row('openscad', 'tool'),
			row('claude-code', 'ai')
		]);
		expect(groups.map((g) => g.id)).toEqual(['ai', 'making', 'home']);
		expect(groups[0].items.map((i) => i.id)).toEqual(['codex', 'claude-code']);
		expect(groups[1].items.map((i) => i.id)).toEqual(['blender', 'openscad']);
	});
});

describe('cloudIntegration', () => {
	it('says nothing leaves the computer without a cloud address', () => {
		const c = cloudIntegration(CLOUD_OFF);
		expect(c.available).toBe(false);
		expect(c.detail).toMatch(/nothing ever leaves/);
		expect(c.setup).toEqual([]);
	});

	it('is ready only when linked and online', () => {
		const base = { ...CLOUD_OFF, configured: true };
		expect(cloudIntegration(base).detail).toMatch(/Not linked/);
		expect(cloudIntegration(base).setup).toHaveLength(1);
		const online = cloudIntegration({ ...base, state: 'online', account: 'sam@example.com' });
		expect(online.available).toBe(true);
		expect(online.detail).toBe('Linked to sam@example.com.');
		const offline = cloudIntegration({ ...base, state: 'offline', account: 'sam@example.com' });
		expect(offline.available).toBe(false);
		expect(offline.detail).toMatch(/offline, retrying/);
	});
});

describe('trustLine', () => {
	it('explains each trust state in one line', () => {
		expect(trustLine({ trust: 'pinned', tls: true, simulated: false })).toMatch(
			/warn you if it ever changes/
		);
		expect(trustLine({ trust: 'ca', tls: true, simulated: false })).toMatch(/verified/);
		expect(trustLine({ trust: null, tls: true, simulated: false })).toBeNull();
		expect(trustLine({ trust: null, tls: false, simulated: false })).toMatch(/Encryption is off/);
		expect(trustLine({ trust: null, tls: false, simulated: true })).toMatch(/simulator/);
	});
});
