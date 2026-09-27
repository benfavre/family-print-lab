CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`level` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`printer_id` text REFERENCES printers(id) ON DELETE set null,
	`job_id` text REFERENCES jobs(id) ON DELETE set null,
	`link` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`read_at` text
);
--> statement-breakpoint
CREATE INDEX `notifications_created` ON `notifications` (`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_read` ON `notifications` (`read_at`);
