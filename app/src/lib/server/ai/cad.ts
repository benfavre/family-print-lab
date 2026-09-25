// AI-assisted parametric design: the model writes OpenSCAD; the server compiles every attempt and
// feeds errors back so the result renders before anyone sees it. Suggestions are not saved until
// the user applies them in the editor.
import type { Provider, Image } from './providers';
import { AI_PROVIDER_NAME } from '$lib/shared/integrations';
import { renderScad, type RenderResult } from '../cad/openscad';
import { AppError } from '../validation';

export const CAD_SYSTEM = `You are an expert OpenSCAD designer making functional, printable parts for a family's Bambu Lab X2D printer (build volume 256 × 256 × 260 mm; FDM; usually PLA or PETG).

Write one complete, self-contained OpenSCAD file:
- No include, use or import statements; no external libraries. Define every module you need.
- Units are millimetres. The part rests on the bed: flat bottom at z = 0, +Z up, centred or in the positive quadrant, within the build volume.
- Put the important dimensions at the top as customizer parameters with a description comment on the line above and a range, for example:
    // Inner width of the tray (mm)
    width = 60; // [20:1:200]
  Group them with /* [Group name] */ sections. Put $fn and internal helper values under /* [Hidden] */. Use true/false for switches and "…" strings for text.
- Printability: walls at least 1.2 mm (2 mm or more when load-bearing); avoid unsupported overhangs steeper than 45° (use chamfers); leave 0.2–0.3 mm clearance per side for parts that fit together; M3 screw holes 3.4 mm, M4 4.5 mm.
- Text: only fonts "Liberation Sans", "Liberation Sans:style=Bold" or "Liberation Mono". Emboss or deboss at least 0.6 mm; letters at least 5 mm tall.
- Keep rendering fast: $fn between 48 and 96, prefer hull() and offset() over minkowski(), no huge loops.
- Anything a young child will handle: rounded edges, no small detachable parts.
- The file must render to a single closed solid.
- The app compiles your file with OpenSCAD and shows it in 3D automatically (and sends back any errors), so never say you could not render it. In the summary, name the dimensions the family should check against the real object before printing.`;

const obj = (properties: Record<string, unknown>) => ({
	type: 'object',
	properties,
	required: Object.keys(properties),
	additionalProperties: false
});
const DESIGN_SCHEMA = obj({
	name: { type: 'string' },
	summary: { type: 'string' },
	source: { type: 'string' }
});
const EDIT_SCHEMA = obj({ summary: { type: 'string' }, source: { type: 'string' } });

export interface CadResult {
	name?: string;
	summary: string;
	source: string;
	render: Omit<RenderResult, 'soup'> & { triangles: number };
	attempts: number;
}

const FORBIDDEN = /^\s*(include|use)\s*<|\bimport\s*\(/m;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

async function compile(source: string) {
	if (FORBIDDEN.test(source))
		return {
			ok: false,
			soup: null,
			diagnostics: [
				{
					level: 'error' as const,
					message: 'include/use/import are not available; define everything in this file.',
					line: null
				}
			],
			echo: [],
			ms: 0
		};
	return renderScad(source);
}

async function refine(
	provider: Provider,
	first: { summary: string; source: string; name?: string },
	context: string,
	signal?: AbortSignal,
	onStage: (text: string) => void = () => {}
): Promise<CadResult> {
	let current = first;
	onStage('Test-rendering the design…');
	let render = await compile(current.source);
	let attempts = 1;
	while (!render.ok && attempts < 3) {
		onStage(`Fixing a render error (attempt ${attempts + 1} of 3)…`);
		const errors = render.diagnostics
			.map((d) => `- ${d.level}${d.line ? ` (line ${d.line})` : ''}: ${d.message}`)
			.join('\n');
		const fixed = await provider.structured<{ summary: string; source: string }>({
			system: CAD_SYSTEM,
			prompt: `${context}\n\nYour last OpenSCAD file does not render:\n${errors}\n\nThe file was:\n\`\`\`openscad\n${clip(current.source, 60_000)}\n\`\`\`\n\nReturn the corrected complete file and a one-sentence summary of the design.`,
			schema: EDIT_SCHEMA,
			effort: 'high',
			signal
		});
		current = { ...current, ...fixed };
		onStage(`Test-rendering attempt ${attempts + 1}…`);
		render = await compile(current.source);
		attempts++;
	}
	const { soup, ...rest } = render;
	return { ...current, render: { ...rest, triangles: soup ? soup.length / 9 : 0 }, attempts };
}

/** Designs a new part from a description (optionally a sketch or photo). */
export async function designPart(
	provider: Provider,
	input: { prompt: string; projectTitle: string; projectDescription: string; image?: Image | null },
	signal?: AbortSignal,
	onStage?: (text: string) => void
) {
	if (!input.prompt.trim()) throw new AppError(400, 'Describe the part you want.');
	onStage?.(`Asking ${AI_PROVIDER_NAME[provider.id]} to design it…`);
	const context = `Project: “${input.projectTitle}”. ${clip(input.projectDescription, 800)}\nRequest: ${clip(input.prompt, 2000)}`;
	const first = await provider.structured<{ name: string; summary: string; source: string }>({
		system: CAD_SYSTEM,
		prompt: `${context}\n\nDesign this part. Return a short name (under 40 characters), a one or two sentence summary of the design and its key dimensions, and the complete OpenSCAD file.${input.image ? ' A reference image is attached.' : ''}`,
		schema: DESIGN_SCHEMA,
		image: input.image,
		effort: 'high',
		signal
	});
	return refine(provider, first, context, signal, onStage);
}

/** Changes an existing design according to an instruction, keeping its parameters where sensible. */
export async function editPart(
	provider: Provider,
	input: {
		source: string;
		instruction: string;
		params: Record<string, unknown>;
		image?: Image | null;
	},
	signal?: AbortSignal,
	onStage?: (text: string) => void
) {
	onStage?.(`Asking ${AI_PROVIDER_NAME[provider.id]} for the change…`);
	if (!input.instruction.trim()) throw new AppError(400, 'Say what to change.');
	const context = `Current parameter values: ${JSON.stringify(input.params)}\nRequested change: ${clip(input.instruction, 2000)}`;
	const first = await provider.structured<{ summary: string; source: string }>({
		system: CAD_SYSTEM,
		prompt: `${context}\n\nHere is the current design:\n\`\`\`openscad\n${clip(input.source, 60_000)}\n\`\`\`\n\nApply the change. Keep the existing parameters and structure unless the change needs otherwise, and update parameter defaults to the current values above. Return the complete new file and a one-sentence summary of what changed.${input.image ? ' A reference image is attached.' : ''}`,
		schema: EDIT_SCHEMA,
		image: input.image,
		effort: 'high',
		signal
	});
	return refine(provider, first, context, signal, onStage);
}
