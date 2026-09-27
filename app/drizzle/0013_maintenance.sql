CREATE TABLE `maintenance_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`printer_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`interval_hours` real,
	`interval_days` integer,
	`last_done_at` text,
	`last_done_hours` real,
	`notes` text DEFAULT '' NOT NULL,
	`source` text,
	`notified_at` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`printer_id`) REFERENCES `printers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `maintenance_tasks_printer` ON `maintenance_tasks` (`printer_id`);--> statement-breakpoint
CREATE TABLE `maintenance_log` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text,
	`printer_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`done_at` text NOT NULL,
	`hours_at` real,
	`note` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `maintenance_tasks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`printer_id`) REFERENCES `printers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `maintenance_log_printer` ON `maintenance_log` (`printer_id`,`done_at`);--> statement-breakpoint
CREATE TABLE `printers_odometer` (
	`printer_id` text PRIMARY KEY NOT NULL,
	`baseline_hours` real DEFAULT 0 NOT NULL,
	`seeded_at` text,
	`ams_seeded_at` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`printer_id`) REFERENCES `printers`(`id`) ON UPDATE no action ON DELETE cascade
);
