// Family features for kids: gentle print limits checked when a child asks, badges for what they made,
// the family gallery (a camera snapshot when a kid's print finishes, when the camera module is there
// and the parent turned it on) and printable certificates. Uses the camera and notifications modules
// when present, through ctx.module (docs/parity/PLAN.md 5.13, 7.5).
import { defineModule, type ModuleContext } from '../../modules';
import type { CameraService, NotifyService } from '../contracts';
import type { BadgeId, LimitReason } from '$lib/shared/kids';
import { KidsService } from './service';
import { kidsSettingsSchema } from './validation';
import { findFfmpeg } from '$lib/server/ffmpeg';

declare module '../../modules' {
	interface ModuleServices {
		kids: KidsService;
	}
}

declare module '../../events' {
	interface LabEventMap {
		/** A child earned a badge. */
		'kid.badge.earned': { profileId: string; badge: BadgeId; jobId: string | null };
		/** A photo was added to the family gallery (by the camera or a grown-up). */
		'kid.photo.added': { itemId: string; profileId: string; jobId: string | null };
		/** A kid's print finished without a camera photo: a grown-up is invited to add one. */
		'kid.photo.wanted': { profileId: string; jobId: string };
		/** A child asked while over a limit (and was told kindly). */
		'kid.limit.reached': { profileId: string; reason: LimitReason };
	}
}

/** A service of a module this package does not depend on (its key may be undeclared here). */
function soft<T>(ctx: ModuleContext, key: string) {
	return () => (ctx.module as (k: string) => unknown)(key) as T | undefined;
}

let offs: (() => void)[] = [];

export default defineModule({
	key: 'kids',
	order: 120,
	// Kid mode reads its own badges, gallery and limits, and gallery pictures (checked per child).
	kidReads: [/^\/api\/kids\/me(\/check)?$/, /^\/api\/kids\/gallery\/[^/]+\/image$/],
	start(ctx) {
		const kids = new KidsService({
			db: ctx.db,
			lab: ctx.lab,
			bus: ctx.bus,
			live: ctx.live,
			settings: ctx.settings(kidsSettingsSchema, kidsSettingsSchema.parse({})),
			camera: soft<CameraService>(ctx, 'camera'),
			notify: soft<NotifyService>(ctx, 'notifications'),
			log: ctx.log,
			ffmpeg: findFfmpeg(ctx.env) ?? undefined
		});
		// The runtime's own listener has closed the job by now (events.ts ordering).
		offs = [
			ctx.bus.on('print.finished', (e) => void kids.onFinished(e)),
			// Requests change the limits' usage shown to the parent.
			ctx.bus.on('request.created', (e) =>
				ctx.live.send('kids:changed', { profileId: e.profileId })
			),
			ctx.bus.on('request.decided', () => ctx.live.send('kids:changed', { profileId: null }))
		];
		// The lab emits after committing. Award manual-print badges before its response, so a
		// certificate opened immediately (or prefetched by its link) already contains the badge.
		const onChange = (e: { kind: string }) => {
			if (e.kind !== 'job') return;
			try {
				kids.refreshBadgesIfChanged();
			} catch (error) {
				ctx.log(`Could not update badges: ${(error as Error).message}`);
			}
		};
		ctx.lab.events.on('change', onChange);
		offs.push(() => ctx.lab.events.off('change', onChange));
		try {
			kids.refreshAllBadges();
		} catch (error) {
			ctx.log(`Could not bring badges up to date: ${(error as Error).message}`);
		}
		return kids;
	},
	stop() {
		for (const off of offs.splice(0)) off();
	}
});
