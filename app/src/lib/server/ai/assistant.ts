// Claude-powered lab assistant. Suggests only: nothing here writes to the workspace; the browser applies
// a suggestion through the normal API when the person clicks.
import type { PrinterStatus, Workspace } from '$lib/shared/domain';
import { AppError } from '../validation';
import type { Image, Provider } from './providers';
import type { AiTask } from '../settings';

const LAYERS = ['', '0.08', '0.12', '0.16', '0.20', '0.24', '0.28'];
const NOZZLES = ['', '0.2', '0.4', '0.6', '0.8'];
const PLATES = ['', 'Textured PEI', 'Smooth PEI', 'Cool plate', 'Engineering plate', 'Other'];
const SUPPORTS = ['None', 'Normal', 'Tree'];
const CATEGORIES = ['Office', 'Home lab', 'Home', 'Creative'];
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const SYSTEM = `You are the lab assistant inside Family Print Lab, a local app a family uses to plan and log 3D prints on a Bambu Lab X2D (dual-nozzle: a main nozzle plus a support nozzle, heated chamber up to 65 °C, 256 × 256 × 260 mm build volume, AMS for multi-material).

How to help:
- Be practical and specific: real dimensions, materials, slicer settings (Bambu Studio / OrcaSlicer terms), and what to measure first.
- Use the workspace snapshot for context: family members, projects, print jobs, spools on the shelf, and the printer's live state when connected. Refer to projects and people by name.
- For anything a child will handle, call out safety plainly: small parts and choking hazards for under-3s and young children, sharp edges, adult supervision near the printer, and that printed parts are not food-safe by default.
- Printer data in the snapshot is read-only; you cannot start, pause or change prints. Say so if asked.
- Suggest models from sites like MakerWorld or Printables by describing what to search for; do not invent URLs.
- Use metric units. Keep answers short: brief paragraphs and "- " bullet lists; **bold** for key settings. No tables or headings.`;

const clip = (s: unknown, n: number): string =>
	typeof s !== 'string' ? '' : s.length > n ? `${s.slice(0, n)}…` : s;

// Compact, model-friendly view of the workspace. Only what helps the assistant.
export function snapshot(state: Workspace, printer: PrinterStatus) {
	const people = new Map(state.profiles.map((p) => [p.id, p.name]));
	const projects = new Map(state.projects.map((p) => [p.id, p.title]));
	const spools = new Map(
		state.spools.map((s) => [s.id, `${s.colorName || s.colorHex} ${s.material}`])
	);
	const jobs = [...state.jobs]
		.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
		.slice(0, 40);
	const lines = [
		'FAMILY',
		...state.profiles.map(
			(p) =>
				`- ${p.name} (${p.age === null ? 'adult' : `age ${p.age}`})${p.interests ? `: ${clip(p.interests, 200)}` : ''}`
		),
		'',
		'PROJECTS',
		...state.projects.map(
			(p) =>
				`- [${p.id}] "${p.title}" for ${people.get(p.profileId)} · ${p.category} · ${p.status}${p.material ? ` · ${p.material}` : ''}${p.description ? ` — ${clip(p.description, 240)}` : ''}${p.notes ? ` | notes: ${clip(p.notes, 300)}` : ''}${p.checklist?.length ? ` | checklist ${p.checklist.filter((c) => c.done).length}/${p.checklist.length}` : ''}`
		),
		'',
		'RECENT PRINT JOBS',
		...(jobs.length
			? jobs.map(
					(j) =>
						`- [${j.id}] ${projects.get(j.projectId)} ${j.revision} · ${j.status} · ${[j.material, j.spoolId ? spools.get(j.spoolId) : '', j.layerHeight && `${j.layerHeight} mm`, j.nozzle && `${j.nozzle} nozzle`, j.plate, j.supports && `supports ${j.supports}`, j.infill !== null && `${j.infill}% infill`, j.grams !== null && `${j.grams} g`, j.minutes !== null && `est ${j.minutes} min`, j.actualMinutes !== null && `took ${j.actualMinutes} min`].filter(Boolean).join(', ')}${j.notes ? ` | ${clip(j.notes, 300)}` : ''}`
				)
			: ['- none yet']),
		'',
		'FILAMENT SPOOLS',
		...(state.spools.length
			? state.spools.map(
					(s) =>
						`- ${s.colorName || s.colorHex} ${s.material}${s.brand ? ` (${s.brand})` : ''}: ${s.remainingGrams} g of ${s.totalGrams} g left${s.notes ? ` | ${clip(s.notes, 160)}` : ''}`
				)
			: ['- none recorded']),
		'',
		'PRINTER'
	];
	if (!printer?.configured) lines.push('- not connected to the app');
	else if (!printer.connected)
		lines.push(`- ${printer.name}: offline${printer.error ? ` (${printer.error})` : ''}`);
	else {
		const s = printer.state;
		if (!s) {
			lines.push(`- ${printer.name}: connected, waiting for its first report`);
			return lines.join('\n');
		}
		lines.push(
			`- ${printer.name}: ${s.gcodeState}${s.task ? `, task "${s.task}"` : ''}${s.percent !== null ? `, ${s.percent}%` : ''}${s.layer !== null ? `, layer ${s.layer}/${s.totalLayers}` : ''}${s.remainingMinutes !== null ? `, ${s.remainingMinutes} min left` : ''}`
		);
		lines.push(
			`- temps: nozzle ${s.nozzle ?? '?'}/${s.nozzleTarget ?? '?'} °C, bed ${s.bed ?? '?'}/${s.bedTarget ?? '?'} °C${s.chamber !== null ? `, chamber ${s.chamber} °C` : ''}${s.printError ? `, error code ${s.printError}` : ''}`
		);
		for (const unit of s.ams || [])
			lines.push(
				`- AMS ${unit.unit}: ${unit.trays.map((t) => (t.type ? `slot ${t.slot} ${t.type}${t.color ? ` ${t.color}` : ''}${t.remain !== null ? ` ${t.remain}%` : ''}${t.active ? ' (loaded)' : ''}` : `slot ${t.slot} empty`)).join('; ')}`
			);
	}
	return lines.join('\n');
}

const obj = (properties: Record<string, unknown>) => ({
	type: 'object',
	properties,
	required: Object.keys(properties),
	additionalProperties: false
});
const settingsSchema = obj({
	layerHeight: { type: 'string', enum: LAYERS },
	nozzle: { type: 'string', enum: NOZZLES },
	plate: { type: 'string', enum: PLATES },
	supports: { type: 'string', enum: SUPPORTS },
	infill: { type: 'integer' }
});

type Input = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export const TASKS: Record<
	string,
	{
		effort: 'low' | 'medium' | 'high';
		schema: Record<string, unknown>;
		prompt: (state: Workspace, input: Input) => string;
	}
> = {
	ideas: {
		effort: 'medium',
		schema: obj({
			ideas: {
				type: 'array',
				items: obj({
					title: { type: 'string' },
					category: { type: 'string', enum: CATEGORIES },
					description: { type: 'string' },
					material: { type: 'string' },
					why: { type: 'string' },
					safety: { type: 'string' },
					checklist: { type: 'array', items: { type: 'string' } }
				})
			}
		}),
		prompt(state: Workspace, input: Input) {
			const person = state.profiles.find((p) => p.id === input.profileId);
			if (!person) throw new AppError(400, 'Choose a family member.');
			return `Suggest 4 new, genuinely useful or delightful print ideas for ${person.name} (${person.age === null ? 'adult' : `age ${person.age}`}${person.interests ? `; interests: ${person.interests}` : ''}).${input.hint ? ` They asked for: ${clip(input.hint, 300)}.` : ''}
Avoid repeating their existing projects. Each idea: a short title (under 60 characters), one of the four categories, a 1-2 sentence description, a material suggestion that suits the X2D and what is on the shelf, one sentence on why it suits them, a safety note (empty string if none), and a 4-7 step checklist starting with what to measure.`;
		}
	},
	diagnose: {
		effort: 'high',
		schema: obj({
			summary: { type: 'string' },
			causes: {
				type: 'array',
				items: obj({
					cause: { type: 'string' },
					likelihood: { type: 'string', enum: ['high', 'medium', 'low'] },
					evidence: { type: 'string' }
				})
			},
			fixes: { type: 'array', items: obj({ change: { type: 'string' }, why: { type: 'string' } }) },
			settings: settingsSchema,
			retry: { type: 'string' }
		}),
		prompt(state: Workspace, input: Input) {
			const job = state.jobs.find((j) => j.id === input.jobId);
			if (!job) throw new AppError(400, 'That print job no longer exists.');
			const project = state.projects.find((p) => p.id === job.projectId),
				spool = state.spools.find((s) => s.id === job.spoolId);
			return `Diagnose print job [${job.id}] of "${project?.title}" (${job.revision || 'no revision'}), status ${job.status}.
Settings: material ${job.material || '?'}${spool ? ` (spool: ${spool.colorName} ${spool.material} ${spool.brand}${spool.notes ? `, ${spool.notes}` : ''})` : ''}, layer ${job.layerHeight || '?'} mm, nozzle ${job.nozzle || '?'} mm, plate ${job.plate || '?'}, supports ${job.supports || '?'}, infill ${job.infill ?? '?'}%, ${job.grams ?? '?'} g, estimate ${job.minutes ?? '?'} min, actual ${job.actualMinutes ?? '?'} min.
What the person wrote: ${job.notes ? `"${clip(job.notes, 1500)}"` : '(nothing)'}
Project notes: ${clip(project?.notes, 800) || '(none)'}
${input.image ? 'A photo of the print is attached.' : 'No photo was provided; say what a photo would help confirm.'}${input.question ? `\nTheir question: ${clip(input.question, 500)}` : ''}
Give the most likely causes ranked, concrete fixes, and the settings you would use for the reprint (keep a setting unchanged if it was fine).`;
		}
	},
	settings: {
		effort: 'medium',
		schema: obj({
			settings: settingsSchema,
			rationale: { type: 'string' },
			tips: { type: 'array', items: { type: 'string' } }
		}),
		prompt(state: Workspace, input: Input) {
			const project = state.projects.find((p) => p.id === input.projectId);
			if (!project) throw new AppError(400, 'Choose a project.');
			return `Recommend Bambu Studio settings for the next print of "${project.title}" (${project.category}): ${clip(project.description, 500)}
Project notes: ${clip(project.notes, 800) || '(none)'}
Planned material: ${clip(input.material, 60) || project.material || 'not chosen'}.
Consider how the part is used (strength, heat, flexibility, looks) and past jobs for this project. Keep the rationale to 2-3 sentences and give up to 4 short tips (orientation, brim, seams, drying).`;
		}
	},
	checklist: {
		effort: 'medium',
		schema: obj({ steps: { type: 'array', items: { type: 'string' } } }),
		prompt(state: Workspace, input: Input) {
			const project = state.projects.find((p) => p.id === input.projectId);
			if (!project) throw new AppError(400, 'Choose a project.');
			const owner = state.profiles.find((p) => p.id === project.profileId);
			return `Write a 5-9 step build checklist for "${project.title}" (${project.category}, for ${owner?.name}${owner?.age !== null && owner?.age !== undefined ? `, age ${owner.age}` : ''}): ${clip(project.description, 500)}
Notes so far: ${clip(project.notes, 800) || '(none)'}
Existing steps: ${project.checklist.map((c) => c.text).join('; ') || '(none)'}
Steps must be short imperative actions (under 80 characters), in order from measuring through installing or handing over, specific to this object.`;
		}
	}
};

export function validImage(image: unknown): Image | null {
	if (image === undefined || image === null) return null;
	const img = image as { mediaType?: string; data?: unknown };
	if (
		typeof image !== 'object' ||
		!IMAGE_TYPES.has(img.mediaType ?? '') ||
		typeof img.data !== 'string' ||
		img.data.length > 7_000_000 ||
		!/^[A-Za-z0-9+/=]+$/.test(img.data)
	)
		throw new AppError(400, 'Photos must be JPEG, PNG, WebP or GIF under 5 MB.');
	return { mediaType: img.mediaType as Image['mediaType'], data: img.data };
}

/** Picks the provider for a task (from Settings). */
export type ProviderResolver = (task: AiTask) => Provider;

export function createAi(resolve: ProviderResolver) {
	async function run(
		task: string,
		state: Workspace,
		printer: PrinterStatus,
		input: Input,
		signal?: AbortSignal
	) {
		const def = TASKS[task];
		if (!def) throw new AppError(404, 'Unknown assistant task.');
		const image = validImage(input.image);
		return resolve(task as AiTask).structured<Input>({
			system: `${SYSTEM}\n\nWORKSPACE SNAPSHOT\n${snapshot(state, printer)}`,
			prompt: def.prompt(state, input),
			schema: def.schema,
			image,
			effort: def.effort,
			signal
		});
	}

	function conversation(messages: unknown): {
		history: { role: 'user' | 'assistant'; content: string }[];
		image: Image | null;
	} {
		if (!Array.isArray(messages) || !messages.length || messages.length > 40)
			throw new AppError(400, 'Invalid conversation.');
		let image: Image | null = null;
		const history = (messages as { role: string; content: string; image?: unknown }[]).map(
			(m, i) => {
				const role = i % 2 === 0 ? 'user' : 'assistant';
				if (
					!m ||
					m.role !== role ||
					typeof m.content !== 'string' ||
					!m.content.trim() ||
					m.content.length > 8000
				)
					throw new AppError(400, 'Invalid conversation.');
				if (role === 'user' && i === messages.length - 1) image = validImage(m.image);
				return { role: role as 'user' | 'assistant', content: m.content };
			}
		);
		if (history.at(-1)?.role !== 'user') throw new AppError(400, 'Invalid conversation.');
		return { history, image };
	}

	/** Streams the reply's text through onText; resolves when complete. */
	async function chat(
		state: Workspace,
		printer: PrinterStatus,
		messages: unknown,
		onText: (text: string) => void,
		signal?: AbortSignal
	) {
		const { history, image } = conversation(messages);
		await resolve('chat').chat(
			{
				system: `${SYSTEM}\n\nWORKSPACE SNAPSHOT (live, ${new Date().toISOString().slice(0, 16)} UTC)\n${snapshot(state, printer)}`,
				messages: history,
				image,
				signal
			},
			onText
		);
	}

	return { run, chat, tasks: Object.keys(TASKS) };
}

export type Assistant = ReturnType<typeof createAi>;
