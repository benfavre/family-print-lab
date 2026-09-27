// The first-run setup guide (/welcome): whether to offer it, and the steps it walks through.

export interface OnboardingState {
	/** Nobody has set the lab up yet: no family profiles, no printers, and the guide never finished or skipped. */
	firstRun: boolean;
	completedAt: string | null;
	skippedAt: string | null;
	profiles: number;
	printers: number;
}

export const ONBOARDING_STEPS = ['welcome', 'printer', 'integrations', 'family', 'done'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const ONBOARDING_STEP_LABEL: Record<OnboardingStep, string> = {
	welcome: 'Welcome',
	printer: 'Printer',
	integrations: 'Tools',
	family: 'Family',
	done: 'Done'
};

/** The guide opens by itself only on a brand new lab, once. */
export function isFirstRun(o: {
	profiles: number;
	printers: number;
	completedAt: string | null;
	skippedAt: string | null;
}): boolean {
	return o.profiles === 0 && o.printers === 0 && !o.completedAt && !o.skippedAt;
}
