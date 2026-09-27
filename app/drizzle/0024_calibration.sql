CREATE TABLE `calibration_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'slicing' NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`printer_id` text,
	`spool_id` text,
	`filament` text,
	`params` text NOT NULL,
	`steps` text DEFAULT '[]' NOT NULL,
	`base_flow_ratio` real,
	`job_id` text,
	`task_id` text,
	`result` text,
	`error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`printer_id`) REFERENCES `printers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`spool_id`) REFERENCES `spools`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `calibration_runs_created` ON `calibration_runs` (`created_at`);
