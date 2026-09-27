// The kids service: limits checked when a child asks, badges from their print history, the family
// gallery (a camera snapshot when a kid's print finishes, else an invitation to add a photo), the
// parent's overview and printable certificates.
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { DB } from '../../db';
import {
	galleryItems,
	jobs,
	kidBadges,
	kidLimits,
	models,
	modelVersions,
	printRequests,
	profiles,
	projects,
	spools
} from '../../db/schema';
import type { Lab } from '../../lab';
import type { EventBus } from '../../events';
import type { LivePublisher } from '../../modules';
import type { SettingsStore } from '../../module-settings';
import type { CameraService, NotifyService } from '../contracts';
import { AppError, parse } from '../../validation';
import type { Job, SlicedInfo } from '$lib/shared/domain';
import {
	BADGES,
	estimateGrams,
	NO_LIMITS,
	type BadgeId,
	type Certificate,
	type EarnedBadge,
	type GalleryItem,
	type KidLimits,
	type KidOverview,
	type KidRequestSummary,
	type KidSelf,
	type KidsOverview,
	type KidsSettings,
	type LimitCheck,
	type PhotoWanted
} from '$lib/shared/kids';
import { blockedNow, checkLimits, usageOf, type CountedAsk } from './limits';
import { earnedBadges, type PrintedThing } from './badges';
import { decodePhoto, fitSnapshot, type PhotoMime } from './images';
import {
	galleryPatch,
	galleryUpload,
	kidLimitsInput,
	kidsSettingsInput,
	type StoredKidsSettings
} from './validation';
import { localTimeZone } from './windows';

export interface KidsDeps {
	db: DB;
	lab: Lab;
	bus: EventBus;
	live: LivePublisher;
	settings: SettingsStore<StoredKidsSettings>;
	/** The camera module's service, when that module is present. */
	camera: () => CameraService | undefined;
	/** The notifications module's service, when present. */
	notify: () => NotifyService | undefined;
	log: (message: string) => void;
	now?: () => Date;
	/** ffmpeg for shrinking large snapshots (default: the system one). */
	ffmpeg?: string;
}

/** How long a finished print keeps inviting a photo. */
const PHOTO_INVITE_DAYS = 30;

const uuid = () => crypto.randomUUID();

export class KidsService {
	constructor(private d: KidsDeps) {}

	private now() {
		return this.d.now?.() ?? new Date();
	}

	private changed(profileId: string | null) {
		this.d.live.send('kids:changed', { profileId });
	}

	// ---------- Settings ----------

	settings(): KidsSettings {
		const { snapshots, timeZone } = this.d.settings.get();
		return { snapshots, timeZone };
	}

	setSettings(input: unknown): KidsSettings {
		const patch = parse(kidsSettingsInput, input);
		this.d.settings.set({ ...this.d.settings.get(), ...patch });
		this.changed(null);
		return this.settings();
	}

	timeZone() {
		return this.d.settings.get().timeZone ?? localTimeZone();
	}

	// ---------- Limits ----------

	private profile(profileId: string) {
		const p = this.d.db.select().from(profiles).where(eq(profiles.id, profileId)).get();
		if (!p) throw new AppError(404, 'That person no longer exists.');
		return p;
	}

	limits(profileId: string): KidLimits {
		const row = this.d.db.select().from(kidLimits).where(eq(kidLimits.profileId, profileId)).get();
		if (!row) return { ...NO_LIMITS };
		return {
			printsPerDay: row.printsPerDay,
			printsPerWeek: row.printsPerWeek,
			gramsPerWeek: row.gramsPerWeek,
			gramsPerMonth: row.gramsPerMonth,
			needApprovalOverGrams: row.needApprovalOverGrams
		};
	}

	setLimits(profileId: string, input: unknown): KidLimits {
		this.profile(profileId);
		const limits = parse(kidLimitsInput, input);
		const updatedAt = this.now().toISOString();
		this.d.db
			.insert(kidLimits)
			.values({ profileId, ...limits, updatedAt })
			.onConflictDoUpdate({ target: kidLimits.profileId, set: { ...limits, updatedAt } })
			.run();
		this.changed(profileId);
		return limits;
	}

	/** Grams for a model version printed in a spool's material (the solid estimate). */
	private gramsFor(versionId: string | null, spoolId: string | null) {
		if (!versionId) return 0;
		const v = this.d.db
			.select({ volume: modelVersions.volume })
			.from(modelVersions)
			.where(eq(modelVersions.id, versionId))
			.get();
		const material = spoolId
			? this.d.db
					.select({ material: spools.material })
					.from(spools)
					.where(eq(spools.id, spoolId))
					.get()?.material
			: undefined;
		return estimateGrams(v?.volume ?? 0, material);
	}

	/** The estimate for asking to print a project now: its newest model's current version. */
	estimateFor(projectId: string, spoolId: string | null) {
		const model = this.d.db
			.select({ currentVersionId: models.currentVersionId })
			.from(models)
			.where(eq(models.projectId, projectId))
			.orderBy(desc(models.createdAt))
			.get();
		return this.gramsFor(model?.currentVersionId ?? null, spoolId);
	}

	/** A child's requests with their estimate, newest first. */
	private requests(profileId: string, since?: string) {
		const rows = this.d.db
			.select({
				id: printRequests.id,
				projectId: printRequests.projectId,
				projectTitle: projects.title,
				status: printRequests.status,
				modelVersionId: printRequests.modelVersionId,
				spoolId: printRequests.spoolId,
				createdAt: printRequests.createdAt,
				jobStatus: jobs.status,
				jobGrams: jobs.grams
			})
			.from(printRequests)
			.innerJoin(projects, eq(projects.id, printRequests.projectId))
			.leftJoin(jobs, eq(jobs.id, printRequests.jobId))
			.where(
				since
					? and(eq(printRequests.profileId, profileId), sql`${printRequests.createdAt} >= ${since}`)
					: eq(printRequests.profileId, profileId)
			)
			.orderBy(desc(printRequests.createdAt))
			.all();
		return rows.map((r) => ({
			...r,
			grams: r.jobGrams ?? this.gramsFor(r.modelVersionId, r.spoolId)
		}));
	}

	/**
	 * Requests that count: waiting ones and those said yes to, unless that print failed or was
	 * stopped (a child is not charged for a print that did not work).
	 */
	private counted(profileId: string): CountedAsk[] {
		const since = new Date(this.now().getTime() - 32 * 86_400_000).toISOString();
		return this.requests(profileId, since)
			.filter(
				(r) =>
					r.status === 'Waiting' ||
					(r.status === 'Approved' && r.jobStatus !== 'Failed' && r.jobStatus !== 'Cancelled')
			)
			.map((r) => ({ at: r.createdAt, grams: r.grams }));
	}

	usage(profileId: string) {
		return usageOf(this.counted(profileId), this.now(), this.timeZone());
	}

	/** Whether one more request of `grams` fits this child's limits. */
	check(profileId: string, grams: number): LimitCheck {
		return checkLimits(this.limits(profileId), this.usage(profileId), grams);
	}

	/** Before a child's request is saved: refuses kindly when it is over a limit. */
	checkAsk(profileId: string, projectId: string, body: unknown): LimitCheck {
		const spoolId =
			body &&
			typeof body === 'object' &&
			typeof (body as { spoolId?: unknown }).spoolId === 'string'
				? (body as { spoolId: string }).spoolId
				: null;
		const check = this.check(profileId, this.estimateFor(projectId, spoolId));
		if (!check.ok) {
			this.d.bus.emit('kid.limit.reached', { profileId, reason: check.reason! });
			throw new AppError(409, check.message);
		}
		return check;
	}

	/** After a request is saved: says yes on the parent's behalf when it is small enough. */
	afterAsk(requestId: string, check: LimitCheck) {
		if (!check.autoApprove) return false;
		try {
			this.d.lab.decideRequest(
				requestId,
				{ decision: 'approve', reply: 'Yes! Small prints can go ahead.', version: 1 },
				'the small-prints rule'
			);
			return true;
		} catch (error) {
			this.d.log(`Could not say yes automatically: ${(error as Error).message}`);
			return false;
		}
	}

	// ---------- Badges ----------

	badges(profileId: string): EarnedBadge[] {
		return this.d.db
			.select()
			.from(kidBadges)
			.where(eq(kidBadges.profileId, profileId))
			.orderBy(kidBadges.earnedAt)
			.all()
			.filter((b) => BADGES.some((x) => x.id === b.badge))
			.map((b) => ({ badge: b.badge as BadgeId, earnedAt: b.earnedAt, jobId: b.jobId }));
	}

	/** A child's successful prints, oldest first. */
	history(profileId: string): PrintedThing[] {
		const rows = this.d.db
			.select({
				id: jobs.id,
				finishedAt: jobs.finishedAt,
				updatedAt: jobs.updatedAt,
				sliced: jobs.sliced,
				dispatch: jobs.dispatch,
				colorHex: spools.colorHex,
				origin: modelVersions.origin
			})
			.from(jobs)
			.innerJoin(projects, eq(projects.id, jobs.projectId))
			.leftJoin(spools, eq(spools.id, jobs.spoolId))
			.leftJoin(modelVersions, eq(modelVersions.id, jobs.modelVersionId))
			.where(and(eq(projects.profileId, profileId), eq(jobs.status, 'Succeeded')))
			.all();
		return rows
			.map((r) => ({
				jobId: r.id,
				at: r.finishedAt ?? r.updatedAt,
				colours: printColours(r.sliced, r.dispatch, r.colorHex),
				fromScratch: r.origin === 'editor'
			}))
			.sort((a, b) => a.at.localeCompare(b.at));
	}

	/** Saves badges the history newly earns (earned badges are kept for good) and celebrates them. */
	refreshBadges(profileId: string) {
		const have = new Set(this.badges(profileId).map((b) => b.badge));
		const fresh = earnedBadges(this.history(profileId), this.timeZone()).filter(
			(e) => !have.has(e.badge)
		);
		if (!fresh.length) return [];
		const earnedAt = this.now().toISOString();
		this.d.db
			.insert(kidBadges)
			.values(fresh.map((e) => ({ profileId, badge: e.badge, jobId: e.jobId, earnedAt })))
			.onConflictDoNothing()
			.run();
		const name = this.profile(profileId).name;
		for (const e of fresh) {
			this.d.bus.emit('kid.badge.earned', { profileId, badge: e.badge, jobId: e.jobId });
			const info = BADGES.find((b) => b.id === e.badge)!;
			this.d.notify()?.notify({
				title: `${name} earned a badge`,
				body: `${info.icon} ${info.title}: ${info.text}`,
				level: 'success',
				link: '/family',
				event: 'kid.badge.earned'
			});
		}
		this.changed(profileId);
		return fresh;
	}

	/** Brings badges up to date for every child (on start, for history made before this module). */
	refreshAllBadges() {
		for (const p of this.kidProfiles()) this.refreshBadges(p.id);
	}

	private kidProfiles() {
		return this.d.db
			.select()
			.from(profiles)
			.where(isNotNull(profiles.kid))
			.orderBy(profiles.name)
			.all();
	}

	// ---------- Gallery ----------

	private galleryQuery() {
		return this.d.db
			.select({
				id: galleryItems.id,
				jobId: galleryItems.jobId,
				profileId: galleryItems.profileId,
				projectId: jobs.projectId,
				projectTitle: projects.title,
				source: galleryItems.source,
				caption: galleryItems.caption,
				createdAt: galleryItems.createdAt
			})
			.from(galleryItems)
			.leftJoin(jobs, eq(jobs.id, galleryItems.jobId))
			.leftJoin(projects, eq(projects.id, jobs.projectId));
	}

	gallery(profileId?: string | null): GalleryItem[] {
		const q = this.galleryQuery();
		return (profileId ? q.where(eq(galleryItems.profileId, profileId)) : q)
			.orderBy(desc(galleryItems.createdAt))
			.all()
			.map((r) => ({ ...r, projectId: r.projectId ?? null, projectTitle: r.projectTitle ?? null }));
	}

	image(id: string) {
		return this.d.db
			.select({
				image: galleryItems.image,
				mime: galleryItems.mime,
				profileId: galleryItems.profileId
			})
			.from(galleryItems)
			.where(eq(galleryItems.id, id))
			.get();
	}

	private jobOwner(jobId: string) {
		const row = this.d.db
			.select({
				profileId: projects.profileId,
				title: projects.title,
				status: jobs.status,
				printerId: jobs.printerId
			})
			.from(jobs)
			.innerJoin(projects, eq(projects.id, jobs.projectId))
			.where(eq(jobs.id, jobId))
			.get();
		if (!row) throw new AppError(404, 'That print job no longer exists.');
		return row;
	}

	private insertPhoto(o: {
		jobId: string | null;
		profileId: string;
		image: Buffer;
		mime: PhotoMime;
		source: 'camera' | 'upload';
		caption: string;
	}) {
		const id = uuid();
		this.d.db
			.insert(galleryItems)
			.values({ id, ...o, createdAt: this.now().toISOString() })
			.run();
		this.d.bus.emit('kid.photo.added', { itemId: id, profileId: o.profileId, jobId: o.jobId });
		this.changed(o.profileId);
		return this.gallery(o.profileId).find((g) => g.id === id)!;
	}

	/** A grown-up adds a photo (of a print, or just of something a maker made). */
	addPhoto(input: unknown): GalleryItem {
		const data = parse(galleryUpload, input);
		const { image, mime } = decodePhoto(data.image);
		let profileId = data.profileId;
		let caption = data.caption;
		if (data.jobId) {
			const owner = this.jobOwner(data.jobId);
			profileId = owner.profileId;
			caption ||= owner.title;
		} else this.profile(profileId!);
		return this.insertPhoto({
			jobId: data.jobId,
			profileId: profileId!,
			image,
			mime,
			source: 'upload',
			caption
		});
	}

	updatePhoto(id: string, input: unknown) {
		const { caption } = parse(galleryPatch, input);
		const row = this.image(id);
		if (!row) throw new AppError(404, 'That photo no longer exists.');
		this.d.db.update(galleryItems).set({ caption }).where(eq(galleryItems.id, id)).run();
		this.changed(row.profileId);
	}

	deletePhoto(id: string) {
		const row = this.image(id);
		if (!row) throw new AppError(404, 'That photo no longer exists.');
		this.d.db.delete(galleryItems).where(eq(galleryItems.id, id)).run();
		this.changed(row.profileId);
	}

	/** Finished kid prints from the last month without a photo, newest first. */
	photosWanted(): PhotoWanted[] {
		const since = new Date(this.now().getTime() - PHOTO_INVITE_DAYS * 86_400_000).toISOString();
		const dismissed = new Set(this.d.settings.get().dismissed);
		const kids = this.kidProfiles().map((p) => p.id);
		if (!kids.length) return [];
		return this.d.db
			.select({
				jobId: jobs.id,
				profileId: projects.profileId,
				projectTitle: projects.title,
				finishedAt: jobs.finishedAt
			})
			.from(jobs)
			.innerJoin(projects, eq(projects.id, jobs.projectId))
			.leftJoin(galleryItems, eq(galleryItems.jobId, jobs.id))
			.where(
				and(
					eq(jobs.status, 'Succeeded'),
					inArray(projects.profileId, kids),
					sql`${galleryItems.id} IS NULL`,
					sql`coalesce(${jobs.finishedAt}, ${jobs.updatedAt}) >= ${since}`
				)
			)
			.orderBy(desc(jobs.finishedAt))
			.all()
			.filter((r) => !dismissed.has(r.jobId))
			.map((r) => ({ ...r, finishedAt: r.finishedAt ?? '' }));
	}

	/** The grown-up does not want a photo of this print. */
	dismissPhoto(jobId: string) {
		const s = this.d.settings.get();
		if (!s.dismissed.includes(jobId))
			this.d.settings.set({ ...s, dismissed: [...s.dismissed, jobId].slice(-200) });
		this.changed(null);
	}

	/**
	 * A kid's print finished: badges, then a photo from the printer camera when the parent turned
	 * that on and a camera is there, else an invitation to add one. Never throws; the snapshot runs
	 * in the background.
	 */
	onFinished(e: { printerId: string; jobId: string | null }): Promise<void> {
		if (!e.jobId) return Promise.resolve();
		const jobId = e.jobId;
		let owner: { profileId: string; title: string };
		try {
			owner = this.jobOwner(jobId);
			if (!this.profile(owner.profileId).kid) return Promise.resolve();
			this.refreshBadges(owner.profileId);
		} catch (error) {
			this.d.log(`Could not update badges: ${(error as Error).message}`);
			return Promise.resolve();
		}
		const camera = this.d.camera();
		if (!this.settings().snapshots || !camera?.has(e.printerId)) {
			this.invite(owner.profileId, jobId, owner.title);
			return Promise.resolve();
		}
		return this.capture(camera, e.printerId, jobId, owner).then(
			() => {},
			(error) => {
				this.d.log(`No snapshot for the gallery: ${(error as Error).message}`);
				this.invite(owner.profileId, jobId, owner.title);
			}
		);
	}

	/** A grown-up asks for a photo of a finished print now, from the camera of the printer that made it. */
	async captureNow(jobId: string): Promise<GalleryItem> {
		const owner = this.jobOwner(jobId);
		const camera = this.d.camera();
		if (!owner.printerId || !camera?.has(owner.printerId))
			throw new AppError(
				409,
				'No camera to take a photo with. Add one from your phone or computer instead.'
			);
		try {
			return await this.capture(camera, owner.printerId, jobId, owner);
		} catch (error) {
			throw new AppError(502, `The camera did not give a photo: ${(error as Error).message}`);
		}
	}

	private async capture(
		camera: CameraService,
		printerId: string,
		jobId: string,
		owner: { profileId: string; title: string }
	) {
		const signal = AbortSignal.timeout(20_000);
		const jpeg = await camera.getSnapshot(printerId, { maxAgeMs: 5000, signal });
		const image = await fitSnapshot(jpeg, { bin: this.d.ffmpeg, signal });
		return this.insertPhoto({
			jobId,
			profileId: owner.profileId,
			image,
			mime: 'image/jpeg',
			source: 'camera',
			caption: owner.title
		});
	}

	private invite(profileId: string, jobId: string, title: string) {
		this.d.bus.emit('kid.photo.wanted', { profileId, jobId });
		const name = this.profile(profileId).name;
		this.d.notify()?.notify({
			title: `${name}’s ${title} is ready`,
			body: 'Add a photo of it to the family gallery.',
			level: 'success',
			link: '/family/gallery',
			event: 'kid.photo.wanted'
		});
		this.changed(profileId);
	}

	// ---------- Overviews ----------

	private requestSummaries(
		profileId: string,
		limits: KidLimits,
		usage: ReturnType<KidsService['usage']>
	) {
		return this.requests(profileId)
			.slice(0, 5)
			.map((r): KidRequestSummary => ({
				id: r.id,
				projectId: r.projectId,
				projectTitle: r.projectTitle,
				status: r.status,
				grams: r.grams,
				createdAt: r.createdAt,
				// A waiting request is already counted in the usage: check what is left without it.
				check:
					r.status === 'Waiting'
						? checkLimits(limits, withoutOne(usage, r, this.now(), this.timeZone()), r.grams)
						: null
			}));
	}

	overview(): KidsOverview {
		const weekAgo = new Date(this.now().getTime() - 7 * 86_400_000).toISOString();
		const kids = this.kidProfiles().map((p): KidOverview => {
			const limits = this.limits(p.id);
			const usage = this.usage(p.id);
			return {
				profileId: p.id,
				limits,
				usage,
				badges: this.badges(p.id),
				galleryCount:
					this.d.db
						.select({ n: sql<number>`count(*)` })
						.from(galleryItems)
						.where(eq(galleryItems.profileId, p.id))
						.get()?.n ?? 0,
				recentRequests: this.requestSummaries(p.id, limits, usage),
				printsLastWeek: this.history(p.id).filter((h) => h.at >= weekAgo).length
			};
		});
		return {
			settings: this.settings(),
			timeZone: this.timeZone(),
			cameraAvailable: !!this.d.camera(),
			kids,
			photosWanted: this.photosWanted()
		};
	}

	/** What a child sees about themselves. */
	self(profileId: string): KidSelf {
		return {
			badges: this.badges(profileId),
			gallery: this.gallery(profileId),
			blocked: blockedNow(this.limits(profileId), this.usage(profileId))
		};
	}

	/** Whether this child could ask for this project now (kind words when not). */
	selfCheck(profileId: string, projectId: string, spoolId: string | null) {
		const check = this.check(profileId, this.estimateFor(projectId, spoolId));
		return { ok: check.ok, message: check.message, autoApprove: check.autoApprove };
	}

	certificate(jobId: string): Certificate | null {
		const row = this.d.db
			.select({
				job: jobs,
				projectTitle: projects.title,
				projectId: projects.id,
				kidName: profiles.name,
				kidColor: profiles.color
			})
			.from(jobs)
			.innerJoin(projects, eq(projects.id, jobs.projectId))
			.innerJoin(profiles, eq(profiles.id, projects.profileId))
			.where(eq(jobs.id, jobId))
			.get();
		if (!row || row.job.status !== 'Succeeded') return null;
		const job = row.job as Job;
		const earned = this.d.db
			.select({ badge: kidBadges.badge })
			.from(kidBadges)
			.where(eq(kidBadges.jobId, jobId))
			.all()
			.map((b) => BADGES.find((x) => x.id === b.badge))
			.filter((b) => !!b);
		const photo = this.d.db
			.select({ id: galleryItems.id })
			.from(galleryItems)
			.where(eq(galleryItems.jobId, jobId))
			.orderBy(desc(galleryItems.createdAt))
			.get();
		const version = job.modelVersionId
			? this.d.db
					.select({
						id: modelVersions.id,
						modelId: modelVersions.modelId,
						has: modelVersions.hasThumbnail
					})
					.from(modelVersions)
					.where(eq(modelVersions.id, job.modelVersionId))
					.get()
			: undefined;
		return {
			jobId,
			kidName: row.kidName,
			kidColor: row.kidColor,
			projectTitle: row.projectTitle,
			finishedAt: job.finishedAt ?? job.updatedAt,
			grams: job.grams,
			minutes: job.actualMinutes ?? job.minutes,
			badges: earned,
			photoId: photo?.id ?? null,
			thumbnail: version?.has ? { modelId: version.modelId, versionId: version.id } : null
		};
	}
}

/** Distinct filament colours of a print: the sliced plate's filaments, the AMS trays sent, the spool. */
export function printColours(
	sliced: SlicedInfo | null,
	dispatch: { amsMapping: number[] } | null,
	spoolHex: string | null
) {
	const colours = new Set<string>();
	const plate = sliced?.plates.find((p) => p.index === sliced.plate) ?? sliced?.plates[0];
	const used = dispatch
		? new Set(dispatch.amsMapping.flatMap((t, i) => (t >= 0 ? [i + 1] : [])))
		: null;
	for (const f of plate?.filaments ?? [])
		if (f.color && (!used || used.has(f.id))) colours.add(f.color.toLowerCase().slice(0, 7));
	if (!colours.size && spoolHex) colours.add(spoolHex.toLowerCase());
	return [...colours];
}

/** The usage without one waiting request (to judge that request on its own). */
function withoutOne(
	usage: ReturnType<KidsService['usage']>,
	r: { createdAt: string; grams: number },
	now: Date,
	tz: string
) {
	const mine = usageOf([{ at: r.createdAt, grams: r.grams }], now, tz);
	return {
		printsToday: usage.printsToday - mine.printsToday,
		printsThisWeek: usage.printsThisWeek - mine.printsThisWeek,
		gramsThisWeek: usage.gramsThisWeek - mine.gramsThisWeek,
		gramsThisMonth: usage.gramsThisMonth - mine.gramsThisMonth
	};
}
