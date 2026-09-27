CREATE TABLE `queue_items` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL REFERENCES jobs(id) ON DELETE cascade,
	`printer_id` text REFERENCES printers(id) ON DELETE set null,
	`position` integer DEFAULT 0 NOT NULL,
	`not_before` text,
	`require_plate_clear` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'waiting' NOT NULL,
	`reason` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "queue_items_status" CHECK("queue_items"."status" IN ('waiting', 'held', 'dispatching', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `queue_items_job` ON `queue_items` (`job_id`);--> statement-breakpoint
CREATE INDEX `queue_items_printer` ON `queue_items` (`printer_id`,`position`);--> statement-breakpoint
CREATE TABLE `queue_printer_state` (
	`printer_id` text PRIMARY KEY NOT NULL REFERENCES printers(id) ON DELETE cascade,
	`auto_dispatch` integer DEFAULT true NOT NULL,
	`plate_clear_needed` integer DEFAULT false NOT NULL,
	`paused` integer DEFAULT false NOT NULL
);
