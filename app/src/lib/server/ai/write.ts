// Writing help for the app's text fields: fleshing out an idea, tidying notes, listing what to decide.
import { z } from 'zod';
import { AppError, parse } from '../validation';

export const WRITE_ACTIONS = {
	flesh:
		'Turn it into a short, practical brief for a 3D-printed part: what it is for and who uses it, the sizes that matter (with units; write "to measure" where unknown), how it attaches or fits, a material and colour suggestion, and one fun or personal touch. Short lines or bullets, under 120 words. Mark assumptions as assumptions.',
	clarify:
		'Rewrite it more clearly and concisely. Keep every fact, size and name; do not add new facts.',
	questions:
		'List the 3 to 6 questions to answer before modelling it: what to measure, how it must fit, loads, where it goes, who will use it. One per line, starting with "- ".',
	measure:
		'Write a checklist of what to measure and record for this project, and the print settings worth noting afterwards. One item per line, starting with "- ".',
	tidy: 'Tidy these notes into a clean, well-ordered list. Keep every number, unit and name exactly; fix spelling; do not add facts.',
	files:
		'Organise these file references one per line, grouped by kind (design, slicer, exports). Suggest a clear naming pattern such as projects/<project>/cad/v01.step where names are missing, marked as a suggestion.',
	interests:
		'Rewrite this as a short, warm description of what this person likes: themes, favourite colours, things they would love to make or use. One or two sentences, keep their words.',
	checklist:
		'Add a short post-print checklist to these notes (first layer, fit test, supports removed, what to change next time). Keep the existing notes above it.'
} as const;
export type WriteAction = keyof typeof WRITE_ACTIONS;

const input = z.strictObject({
	action: z.enum(Object.keys(WRITE_ACTIONS) as [WriteAction, ...WriteAction[]]),
	field: z.string().max(60),
	text: z.string().max(8000),
	context: z.record(z.string().max(40), z.string().max(2000)).default({})
});

export const WRITE_SYSTEM = `You help a family plan and record 3D-printing projects on a Bambu Lab X2D (FDM, 256 × 256 × 260 mm, usually PLA or PETG).
You are editing one text field in their app. Reply with only the new text for that field: no preamble, no quotes, no headings, no markdown emphasis. Plain lines; simple "- " bullets are fine.
Write in the same language as their text. Be concrete and practical; never pad.`;

/** Builds the chat request for one writing action. */
export function writeRequest(raw: unknown) {
	const req = parse(input, raw);
	if (!req.text.trim() && !['flesh', 'questions', 'measure'].includes(req.action))
		throw new AppError(400, 'Write something first; the AI works from your text.');
	const context = Object.entries(req.context)
		.filter(([, v]) => v.trim())
		.map(([k, v]) => `${k}: ${v.trim()}`)
		.join('\n');
	return {
		system: WRITE_SYSTEM,
		messages: [
			{
				role: 'user' as const,
				content: `${context ? `About the project:\n${context}\n\n` : ''}Field: ${req.field}\nCurrent text:\n${req.text.trim() || '(empty)'}\n\nTask: ${WRITE_ACTIONS[req.action]}`
			}
		]
	};
}
