CREATE TABLE `hms_events` (
	`id` text PRIMARY KEY NOT NULL,
	`printer_id` text NOT NULL,
	`kind` text NOT NULL,
	`code` text NOT NULL,
	`severity` text NOT NULL,
	`text` text NOT NULL,
	`raised_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`cleared_at` text,
	`job_id` text,
	FOREIGN KEY (`printer_id`) REFERENCES `printers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `hms_events_printer` ON `hms_events` (`printer_id`,`raised_at`);--> statement-breakpoint
CREATE INDEX `hms_events_job` ON `hms_events` (`job_id`);
