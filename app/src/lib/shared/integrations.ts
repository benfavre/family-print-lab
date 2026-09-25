// The tools the lab connects to, as shown on the Integrations page and in the top bar.

export const AI_PROVIDERS = ['claude-code', 'codex', 'anthropic-api'] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];
/** Short names for buttons and credits. */
export const AI_PROVIDER_NAME: Record<AiProviderId, string> = {
	'claude-code': 'Claude',
	codex: 'ChatGPT',
	'anthropic-api': 'Claude API'
};
/** How each one is reached and billed. */
export const AI_PROVIDER_VIA: Record<AiProviderId, string> = {
	'claude-code': 'Claude subscription, via Claude Code',
	codex: 'ChatGPT subscription, via Codex',
	'anthropic-api': 'Anthropic API key, billed per use'
};

export type IntegrationId = AiProviderId | 'blender' | 'openscad' | 'printer';

export interface IntegrationStatus {
	id: IntegrationId;
	kind: 'ai' | 'tool' | 'printer';
	name: string;
	via: string;
	available: boolean;
	detail: string;
	version?: string | null;
	/** What this integration does in the lab right now. */
	powers: string[];
	/** Steps to set it up, shown when it is not ready. Commands are copyable. */
	setup: { text: string; command?: string }[];
}

export interface IntegrationsReport {
	items: IntegrationStatus[];
	checkedAt: string;
	routing: Record<string, AiProviderId>;
	models: Record<AiProviderId, string>;
	tasks: { id: string; label: string }[];
}

export interface IntegrationTest {
	ok: boolean;
	ms: number;
	detail: string;
}
