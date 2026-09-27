// The AMS sync data: tray ↔ spool links, RFID spools added from trays, and per-tray charges for
// finished prints. Writes that touch spools bump the workspace change id the way Lab does, so open
// tabs refresh; charge refunds happen in SQLite triggers (drizzle/0007_ams.sql).
import { and, eq, sql } from 'drizzle-orm';
import type { DB } from '../../db';
import type { Lab } from '../../lab';
import { amsLinks, jobs, meta, spoolCharges, spools } from '../../db/schema';
import { AppError } from '../../validation';
import { planCharges, type PlannedCharge } from './charges';
import {
	matchTray,
	sameRfid,
	spoolFromTray,
	stillHolds,
	type AmsLink,
	type AmsSpool
} from '$lib/shared/ams';
import { CONSUMING_JOB, type Job } from '$lib/shared/domain';
import type { GlobalTray, PrinterTray } from '$lib/shared/printers/status';

type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
const round1 = (n: number) => Math.round(n * 10) / 10;

export interface ChargeResult {
	jobId: string;
	printerId: string;
	charges: PlannedCharge[];
}

export class AmsStore {
	constructor(
		private db: DB,
		private lab: Lab
	) {}

	/** A write that changes spools: one transaction, then the workspace change id moves on. */
	private write<T>(fn: (tx: Tx) => T): T {
		const value = this.db.transaction((tx) => {
			const v = fn(tx);
			tx.insert(meta)
				.values({ key: 'change_id', value: '1' })
				.onConflictDoUpdate({
					target: meta.key,
					set: { value: sql`CAST(${meta.value} AS INTEGER) + 1` }
				})
				.run();
			return v;
		});
		this.lab.events.emit('change', { changeId: this.lab.changeId(), kind: 'spool' });
		return value;
	}

	// ---------- Reads ----------

	links(printerId?: string): AmsLink[] {
		const q = this.db.select().from(amsLinks);
		return (printerId ? q.where(eq(amsLinks.printerId, printerId)) : q).all();
	}

	linkFor(printerId: string, tray: GlobalTray): AmsLink | undefined {
		return this.db
			.select()
			.from(amsLinks)
			.where(and(eq(amsLinks.printerId, printerId), eq(amsLinks.tray, tray)))
			.get();
	}

	spool(id: string): AmsSpool | undefined {
		return this.db.select().from(spools).where(eq(spools.id, id)).get() as AmsSpool | undefined;
	}

	spools(): AmsSpool[] {
		return this.db.select().from(spools).all() as AmsSpool[];
	}

	charges(jobId: string) {
		return this.db.select().from(spoolCharges).where(eq(spoolCharges.jobId, jobId)).all();
	}

	// ---------- Links ----------

	private linkTx(tx: Tx, printerId: string, tray: PrinterTray, spool: AmsSpool) {
		// A spool is in one tray at a time, and a tray holds one spool.
		tx.delete(amsLinks).where(eq(amsLinks.spoolId, spool.id)).run();
		tx.delete(amsLinks)
			.where(and(eq(amsLinks.printerId, printerId), eq(amsLinks.tray, tray.global)))
			.run();
		tx.insert(amsLinks)
			.values({
				printerId,
				tray: tray.global,
				spoolId: spool.id,
				lastRemain: tray.remain,
				lastUuid: tray.trayUuid
			})
			.run();
	}

	/**
	 * Links a spool to a tray (the person confirmed a suggestion or picked it). A tray with an RFID tag
	 * teaches the spool its tag, so it is recognised by itself next time.
	 */
	link(printerId: string, tray: PrinterTray, spoolId: string) {
		const spool = this.spool(spoolId);
		if (!spool) throw new AppError(404, 'That spool no longer exists.');
		if (!tray.type) throw new AppError(409, 'That tray is empty.');
		if (
			(spool.rfidUuid || spool.rfidTag) &&
			(tray.trayUuid || tray.tagUid) &&
			!sameRfid(tray, spool)
		)
			throw new AppError(409, 'That tray holds a different Bambu spool (its RFID tag differs).');
		const teach =
			!spool.rfidUuid &&
			!!tray.trayUuid &&
			!this.db.select().from(spools).where(eq(spools.rfidUuid, tray.trayUuid)).get();
		if (!teach) {
			this.db.transaction((tx) => this.linkTx(tx, printerId, tray, spool));
			return;
		}
		this.write((tx) => {
			this.linkTx(tx, printerId, tray, spool);
			tx.update(spools)
				.set({
					rfidUuid: tray.trayUuid,
					rfidTag: tray.tagUid,
					bambuInfoIdx: spool.bambuInfoIdx ?? (tray.infoIdx || null),
					version: sql`${spools.version} + 1`
				})
				.where(eq(spools.id, spool.id))
				.run();
		});
	}

	unlink(printerId: string, tray: GlobalTray): boolean {
		return (
			this.db
				.delete(amsLinks)
				.where(and(eq(amsLinks.printerId, printerId), eq(amsLinks.tray, tray)))
				.run().changes > 0
		);
	}

	/** "Add to Filament": a new shelf spool from what the tray reports, linked to it. */
	addFromTray(printerId: string, tray: PrinterTray): string {
		if (!tray.type) throw new AppError(409, 'That tray is empty.');
		const known = this.spools().find((s) => sameRfid(tray, s));
		if (known) throw new AppError(409, 'This spool is already on the shelf.');
		const { input, rfid } = spoolFromTray(tray);
		const id = this.lab.createSpool(input);
		this.write((tx) => {
			tx.update(spools).set(rfid).where(eq(spools.id, id)).run();
			const spool = tx.select().from(spools).where(eq(spools.id, id)).get() as AmsSpool;
			this.linkTx(tx, printerId, tray, spool);
		});
		return id;
	}

	/**
	 * Keeps a printer's links in step with its trays: drops links whose tray no longer holds the spool,
	 * remembers remain/uuid, and links RFID spools the shelf already knows (moving them from another
	 * tray). Returns whether any link changed.
	 */
	sync(printerId: string, trays: PrinterTray[]): boolean {
		const byTray = new Map(trays.map((t) => [t.global, t]));
		const all = this.spools();
		const spoolById = new Map(all.map((s) => [s.id, s]));
		let changed = false;
		this.db.transaction((tx) => {
			for (const link of tx
				.select()
				.from(amsLinks)
				.where(eq(amsLinks.printerId, printerId))
				.all()) {
				const tray = byTray.get(link.tray);
				const spool = spoolById.get(link.spoolId);
				const where = and(eq(amsLinks.printerId, printerId), eq(amsLinks.tray, link.tray));
				if (!spool || !stillHolds(tray, spool)) {
					tx.delete(amsLinks).where(where).run();
					changed = true;
				} else if (tray && (tray.remain !== link.lastRemain || tray.trayUuid !== link.lastUuid))
					tx.update(amsLinks)
						.set({ lastRemain: tray.remain, lastUuid: tray.trayUuid })
						.where(where)
						.run();
			}
			const linked = tx.select().from(amsLinks).all();
			for (const tray of trays) {
				if (!tray.type || !(tray.trayUuid || tray.tagUid)) continue;
				if (linked.some((l) => l.printerId === printerId && l.tray === tray.global)) continue;
				const match = matchTray(tray, all);
				if (match.kind !== 'rfid') continue;
				this.linkTx(tx, printerId, tray, spoolById.get(match.spoolId)!);
				changed = true;
			}
		});
		return changed;
	}

	/** Which spool is in a tray right now (the SpoolSyncService contract). */
	spoolForTray(printerId: string, tray: GlobalTray): string | null {
		return this.linkFor(printerId, tray)?.spoolId ?? null;
	}

	// ---------- Usage ----------

	/**
	 * Charges a finished (fraction 1) or failed print to the spools in the trays it used, once per job.
	 * Jobs without a dispatch (not sent from the app) or without a sliced file keep Lab's single-spool
	 * path. When trays pay, Lab's own charge for the job's spool is given back so the print is not
	 * counted twice (charge_grams 0 with charge_spool_id = spool_id is how Lab marks "nothing to
	 * refund", so it does not charge again on later edits).
	 */
	chargeJob(jobId: string, fraction: number): ChargeResult | null {
		const job = this.lab.getJob(jobId) as Job | undefined;
		if (!job?.dispatch || !job.sliced || !CONSUMING_JOB.has(job.status)) return null;
		if (this.charges(jobId).length) return null;
		const plate =
			job.sliced.plates.find((p) => p.index === job.dispatch!.plate) ??
			job.sliced.plates.find((p) => p.index === job.sliced!.plate);
		if (!plate) return null;
		const printerId = job.dispatch.printerId;
		const links = new Map(this.links(printerId).map((l) => [l.tray, l.spoolId]));
		const plan = planCharges({
			filaments: plate.filaments,
			dispatch: job.dispatch,
			links,
			fraction
		});
		if (!plan.length) return null;
		const charged: PlannedCharge[] = [];
		this.write((tx) => {
			if (job.chargeSpoolId && job.chargeGrams > 0 && job.chargeSpoolId === job.spoolId) {
				tx.update(spools)
					.set({
						remainingGrams: sql`min(${spools.totalGrams}, ${spools.remainingGrams} + ${job.chargeGrams})`,
						version: sql`${spools.version} + 1`
					})
					.where(eq(spools.id, job.chargeSpoolId))
					.run();
				tx.update(jobs).set({ chargeGrams: 0 }).where(eq(jobs.id, job.id)).run();
			}
			for (const c of plan) {
				const spool = tx.select().from(spools).where(eq(spools.id, c.spoolId)).get();
				if (!spool) continue;
				const grams = round1(Math.min(c.grams, spool.remainingGrams));
				// No updated_at: that marks a weight typed in by hand (the baseline trigger).
				tx.update(spools)
					.set({
						remainingGrams: round1(spool.remainingGrams - grams),
						version: sql`${spools.version} + 1`
					})
					.where(eq(spools.id, spool.id))
					.run();
				tx.insert(spoolCharges)
					.values({ id: crypto.randomUUID(), jobId, spoolId: spool.id, grams, tray: c.tray })
					.run();
				charged.push({ ...c, grams });
			}
		});
		return { jobId, printerId, charges: charged };
	}

	/** Sets a spool's Spoolman id (import) or clears it. */
	setSpoolmanId(spoolId: string, spoolmanId: number | null) {
		this.write((tx) =>
			tx
				.update(spools)
				.set({ spoolmanId, version: sql`${spools.version} + 1` })
				.where(eq(spools.id, spoolId))
				.run()
		);
	}
}
