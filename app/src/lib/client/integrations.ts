// Presentation for integrations: a glyph per tool (generic shapes, not brand logos).
import type { IntegrationId } from '$lib/shared/integrations';

export const INTEGRATION_GLYPH: Partial<Record<IntegrationId, string>> = {
	'claude-code': '✳',
	codex: '◎',
	'anthropic-api': '⌁',
	blender: '◉',
	openscad: '⬡',
	slicer: '▤',
	printer: '▣'
};

/** A tool's glyph, with a neutral one for integrations added by modules. */
export const integrationGlyph = (id: IntegrationId) => INTEGRATION_GLYPH[id] ?? '◇';
