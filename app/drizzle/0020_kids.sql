CREATE TABLE `kid_limits` (
	`profile_id` text PRIMARY KEY NOT NULL,
	`prints_per_day` integer,
	`prints_per_week` integer,
	`grams_per_week` integer,
	`grams_per_month` integer,
	`need_approval_over_grams` integer,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `gallery_items` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text,
	`profile_id` text NOT NULL,
	`image` blob NOT NULL,
	`mime` text NOT NULL,
	`source` text DEFAULT 'upload' NOT NULL,
	`caption` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gallery_items_profile` ON `gallery_items` (`profile_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `gallery_items_job` ON `gallery_items` (`job_id`);--> statement-breakpoint
CREATE TABLE `kid_badges` (
	`profile_id` text NOT NULL,
	`badge` text NOT NULL,
	`earned_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`job_id` text,
	PRIMARY KEY(`profile_id`, `badge`),
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null
);
