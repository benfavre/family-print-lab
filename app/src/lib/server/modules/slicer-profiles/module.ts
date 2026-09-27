// slicer-profiles: Bambu Studio's system presets plus the user's own, resolved as Bambu Studio does
// (lib/server/profiles). Others reach it with ctx.module('slicer-profiles'): `profiles` is the
// ProfileService from shared/slicer/profiles.ts, `bundleForJob` the flat config a job slices with.
import { defineModule } from '../../modules';
import type { ProfileServiceModule } from '../contracts';
import { SlicerProfiles } from '../../profiles/service';
import type { ProfileLibrary } from '../../profiles/library';

export type SlicerProfilesService = ProfileServiceModule & {
	profiles: ProfileLibrary;
	/** Everything else: user presets, job settings, spool presets, trays. */
	lab: SlicerProfiles;
	bundleForJob: SlicerProfiles['bundleForJob'];
	forJob: SlicerProfiles['forJob'];
};

declare module '../../modules' {
	interface ModuleServices {
		'slicer-profiles': SlicerProfilesService;
	}
}

let current: SlicerProfiles | null = null;

export default defineModule({
	key: 'slicer-profiles',
	order: 40,
	start(ctx): SlicerProfilesService {
		const lab = (current = new SlicerProfiles({
			db: ctx.db,
			lab: ctx.lab,
			printers: ctx.printers,
			env: ctx.env,
			changed: () => ctx.live.send('slicer-profiles:presets', {})
		}));
		return {
			profiles: lab.profiles,
			lab,
			bundleForJob: (jobId) => lab.bundleForJob(jobId),
			forJob: (jobId) => lab.forJob(jobId)
		};
	},
	stop() {
		current = null;
	},
	integrations: () => {
		if (!current) return [];
		const v = current.profiles.vendor();
		const loc = current.profiles.location();
		const users = current.store.list().length;
		return [
			{
				id: 'slicer-profiles',
				kind: 'module',
				name: 'Slicer profiles',
				via: 'Bambu Studio system presets',
				available: !!v,
				version: v?.version ?? null,
				detail: v
					? `Bambu Studio ${v.tag} presets${loc?.source === 'cli' ? ' from the installed Bambu Studio' : ''}; ${users} of your own.`
					: (current.profiles.missing() ?? ''),
				powers: v
					? ['Printer, process and filament presets', 'Your own presets and per-job settings']
					: [],
				setup: v
					? []
					: [
							{
								text: 'Fetch the presets at the pinned Bambu Studio version (about 15 MB):',
								command: 'bun run profiles:fetch'
							},
							{ text: 'Or install Bambu Studio; its presets are used until then.' }
						]
			}
		];
	}
});
