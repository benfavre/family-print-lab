// Presentation for integrations: a glyph per tool (generic shapes, not brand logos).
import type { IntegrationId } from '$lib/shared/integrations';

export const INTEGRATION_GLYPH: Record<IntegrationId, string> = {
	'claude-code': '✳',
	codex: '◎',
	'anthropic-api': '⌁',
	blender: '◉',
	openscad: '⬡',
	slicer: '▤',
	printer: '▣'
};
