// onboarding: remembers whether the first-run setup guide (/welcome) was finished or skipped, so it
// opens by itself only on a brand new lab. The guide itself uses the existing printer, settings and
// profile routes; nothing here talks to a printer.
import { count } from 'drizzle-orm';
import { z } from 'zod';
import { defineModule } from '$lib/server/modules';
import { profiles } from '$lib/server/db/schema';
import { parse } from '$lib/server/validation';
import { isFirstRun, type OnboardingState } from '$lib/shared/onboarding';

export interface OnboardingService {
	state(): OnboardingState;
	/** `finish` when the guide reached its last step, `skip` when someone chose to set up later. */
	mark(input: unknown): OnboardingState;
}

declare module '$lib/server/modules' {
	interface ModuleServices {
		onboarding: OnboardingService;
	}
}

const stored = z.object({
	completedAt: z.string().max(40).nullable(),
	skippedAt: z.string().max(40).nullable()
});
export const markInput = z.strictObject({ action: z.enum(['finish', 'skip']) });

export default defineModule({
	key: 'onboarding',
	start(ctx): OnboardingService {
		const store = ctx.settings(stored, { completedAt: null, skippedAt: null });
		const state = (): OnboardingState => {
			const saved = store.get();
			const counts = {
				profiles: ctx.db.select({ n: count() }).from(profiles).get()?.n ?? 0,
				printers: ctx.printers.info().length
			};
			return { ...saved, ...counts, firstRun: isFirstRun({ ...saved, ...counts }) };
		};
		return {
			state,
			mark(input) {
				const { action } = parse(markInput, input);
				const now = new Date().toISOString();
				const saved = store.get();
				store.set(
					action === 'finish' ? { ...saved, completedAt: now } : { ...saved, skippedAt: now }
				);
				return state();
			}
		};
	}
});
