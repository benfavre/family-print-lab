// Family features for kids, as the browser sees them: print limits and how much of them is used, the
// family gallery, and badges. The rules live on the server (src/lib/server/modules/kids).
import type { PrintRequestStatus } from './domain';

/** Limits for one child; null means no limit of that kind. */
export interface KidLimits {
	printsPerDay: number | null;
	printsPerWeek: number | null;
	gramsPerWeek: number | null;
	gramsPerMonth: number | null;
	/** Requests up to this many grams (and within the limits) are said yes to without asking. */
	needApprovalOverGrams: number | null;
}

export const NO_LIMITS: KidLimits = {
	printsPerDay: null,
	printsPerWeek: null,
	gramsPerWeek: null,
	gramsPerMonth: null,
	needApprovalOverGrams: null
};

/** What a child asked for so far in the current day, week (from Monday) and month. */
export interface LimitUsage {
	printsToday: number;
	printsThisWeek: number;
	gramsThisWeek: number;
	gramsThisMonth: number;
}

export type LimitReason = 'day' | 'week' | 'grams-week' | 'grams-month';

export interface LimitCheck {
	ok: boolean;
	/** Which limit says no (the first one, in the order above). */
	reason: LimitReason | null;
	/** Kind words for the child (empty when ok). */
	message: string;
	/** Plain words for the grown-up (empty when ok). */
	parentText: string;
	/** The estimate the check used. */
	grams: number;
	usage: LimitUsage;
	limits: KidLimits;
	/** Within the limits and small enough to say yes without asking. */
	autoApprove: boolean;
}

export type BadgeId =
	| 'first-print'
	| 'prints-5'
	| 'prints-10'
	| 'prints-25'
	| 'multi-colour'
	| 'from-scratch'
	| 'rainbow'
	| 'week-streak';

export interface BadgeInfo {
	id: BadgeId;
	icon: string;
	title: string;
	/** How it is earned, in words a child understands. */
	text: string;
}

export const BADGES: BadgeInfo[] = [
	{ id: 'first-print', icon: '🌟', title: 'First print', text: 'Your very first print!' },
	{ id: 'prints-5', icon: '🖐️', title: 'Five prints', text: 'Five things made.' },
	{ id: 'prints-10', icon: '🔟', title: 'Ten prints', text: 'Ten things made.' },
	{ id: 'prints-25', icon: '🏆', title: 'Super maker', text: 'Twenty-five things made!' },
	{
		id: 'multi-colour',
		icon: '🎨',
		title: 'Many colours',
		text: 'A print with more than one colour.'
	},
	{
		id: 'from-scratch',
		icon: '✏️',
		title: 'My own design',
		text: 'Printed a design you made from scratch.'
	},
	{
		id: 'rainbow',
		icon: '🌈',
		title: 'Rainbow maker',
		text: 'Printed in three different colours.'
	},
	{
		id: 'week-streak',
		icon: '🔥',
		title: 'Three-week streak',
		text: 'Something printed three weeks in a row.'
	}
];

export const badgeInfo = (id: string) => BADGES.find((b) => b.id === id);

export interface EarnedBadge {
	badge: BadgeId;
	earnedAt: string;
	jobId: string | null;
}

/** A gallery photo without its image (fetch that from imageUrl). */
export interface GalleryItem {
	id: string;
	jobId: string | null;
	profileId: string;
	projectId: string | null;
	projectTitle: string | null;
	source: 'camera' | 'upload';
	caption: string;
	createdAt: string;
}

export const galleryImageUrl = (id: string) => `/api/kids/gallery/${id}/image`;

/** A finished print that has no photo yet: the grown-up is invited to add one. */
export interface PhotoWanted {
	jobId: string;
	profileId: string;
	projectTitle: string;
	finishedAt: string;
}

export interface KidRequestSummary {
	id: string;
	projectId: string;
	projectTitle: string;
	status: PrintRequestStatus;
	grams: number;
	createdAt: string;
	/** For waiting requests: what the limits say about it now. */
	check: LimitCheck | null;
}

export interface KidOverview {
	profileId: string;
	limits: KidLimits;
	usage: LimitUsage;
	badges: EarnedBadge[];
	galleryCount: number;
	recentRequests: KidRequestSummary[];
	/** Prints finished in the last week. */
	printsLastWeek: number;
}

export interface KidsSettings {
	/** Take a photo with the printer camera when a kid's print finishes (needs a camera). */
	snapshots: boolean;
	/** IANA time zone for the day, week and month limits; null = this computer's. */
	timeZone: string | null;
}

export interface KidsOverview {
	settings: KidsSettings;
	/** The time zone in use. */
	timeZone: string;
	cameraAvailable: boolean;
	kids: KidOverview[];
	photosWanted: PhotoWanted[];
}

/** What a child sees about themselves in kid mode. */
export interface KidSelf {
	badges: EarnedBadge[];
	gallery: GalleryItem[];
	/** Set when the child cannot ask for any print right now (kind words). */
	blocked: string | null;
}

/** Everything a printable certificate shows. */
export interface Certificate {
	jobId: string;
	kidName: string;
	kidColor: string;
	projectTitle: string;
	finishedAt: string;
	grams: number | null;
	minutes: number | null;
	badges: BadgeInfo[];
	photoId: string | null;
	thumbnail: { modelId: string; versionId: string } | null;
}

/** Filament densities in g/cm³ (typical datasheet values), for estimating a part's weight. */
const DENSITY: Record<string, number> = {
	PLA: 1.24,
	PETG: 1.27,
	ABS: 1.04,
	ASA: 1.07,
	TPU: 1.21,
	PC: 1.2,
	PA: 1.14
};

/**
 * Grams for a part of this volume printed solid, the way the request card shows it ("about N g
 * solid"). Real prints with infill use less, so limits err on the generous side for the parent.
 */
export function estimateGrams(volumeMm3: number, material = 'PLA') {
	const key = Object.keys(DENSITY).find((k) => material.toUpperCase().startsWith(k));
	return Math.round((Math.max(0, volumeMm3) / 1000) * DENSITY[key ?? 'PLA']);
}
