ALTER TABLE `spools` ADD `rfid_uuid` text;--> statement-breakpoint
ALTER TABLE `spools` ADD `rfid_tag` text;--> statement-breakpoint
ALTER TABLE `spools` ADD `bambu_info_idx` text;--> statement-breakpoint
ALTER TABLE `spools` ADD `spoolman_id` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `spools_rfid_uuid` ON `spools` (`rfid_uuid`) WHERE "spools"."rfid_uuid" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `ams_links` (
	`printer_id` text NOT NULL,
	`tray` integer NOT NULL,
	`spool_id` text NOT NULL,
	`linked_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`last_remain` integer,
	`last_uuid` text,
	PRIMARY KEY(`printer_id`, `tray`),
	FOREIGN KEY (`printer_id`) REFERENCES `printers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`spool_id`) REFERENCES `spools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ams_links_spool` ON `ams_links` (`spool_id`);--> statement-breakpoint
CREATE TABLE `spool_charges` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`spool_id` text NOT NULL,
	`grams` real NOT NULL,
	`tray` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`spool_id`) REFERENCES `spools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `spool_charges_job` ON `spool_charges` (`job_id`);--> statement-breakpoint
CREATE INDEX `spool_charges_spool` ON `spool_charges` (`spool_id`);--> statement-breakpoint
-- Deleting a job gives its per-tray charges back to the spools (like Lab.refund for the single-spool path).
CREATE TRIGGER `spool_charges_refund_on_delete` BEFORE DELETE ON `jobs`
BEGIN
	UPDATE `spools` SET
		`remaining_grams` = min(`total_grams`, `remaining_grams` + (SELECT coalesce(sum(c.`grams`), 0) FROM `spool_charges` c WHERE c.`job_id` = OLD.`id` AND c.`spool_id` = `spools`.`id`)),
		`version` = `version` + 1
	WHERE `id` IN (SELECT `spool_id` FROM `spool_charges` WHERE `job_id` = OLD.`id` AND `grams` > 0);
	DELETE FROM `spool_charges` WHERE `job_id` = OLD.`id`;
END;
--> statement-breakpoint
-- A job that no longer consumed filament (back in the queue, cancelled) gives it back too.
CREATE TRIGGER `spool_charges_refund_on_status` AFTER UPDATE OF `status` ON `jobs`
WHEN NEW.`status` NOT IN ('Succeeded', 'Failed')
BEGIN
	UPDATE `spools` SET
		`remaining_grams` = min(`total_grams`, `remaining_grams` + (SELECT coalesce(sum(c.`grams`), 0) FROM `spool_charges` c WHERE c.`job_id` = NEW.`id` AND c.`spool_id` = `spools`.`id`)),
		`version` = `version` + 1
	WHERE `id` IN (SELECT `spool_id` FROM `spool_charges` WHERE `job_id` = NEW.`id` AND `grams` > 0);
	DELETE FROM `spool_charges` WHERE `job_id` = NEW.`id`;
END;
--> statement-breakpoint
-- A weight typed in by hand (Lab.updateSpool sets updated_at; charges and refunds do not) is a new
-- baseline: earlier charges stay recorded but are no longer refundable, as Lab does for jobs.
CREATE TRIGGER `spool_charges_baseline` AFTER UPDATE OF `remaining_grams`, `total_grams` ON `spools`
WHEN NEW.`updated_at` IS NOT OLD.`updated_at`
	AND (NEW.`remaining_grams` != OLD.`remaining_grams` OR NEW.`total_grams` != OLD.`total_grams`)
BEGIN
	UPDATE `spool_charges` SET `grams` = 0 WHERE `spool_id` = NEW.`id`;
END;
