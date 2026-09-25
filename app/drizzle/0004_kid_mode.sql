CREATE TABLE `print_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`model_version_id` text,
	`spool_id` text,
	`status` text DEFAULT 'Waiting' NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`reply` text DEFAULT '' NOT NULL,
	`job_id` text,
	`decided_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`model_version_id`) REFERENCES `model_versions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`spool_id`) REFERENCES `spools`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `print_requests_status` ON `print_requests` (`status`);--> statement-breakpoint
CREATE INDEX `print_requests_project` ON `print_requests` (`project_id`);--> statement-breakpoint
ALTER TABLE `profiles` ADD `kid` text;