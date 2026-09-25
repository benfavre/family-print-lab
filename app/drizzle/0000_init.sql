CREATE TABLE `activity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	`project_id` text,
	`job_id` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `activity_project` ON `activity` (`project_id`,`at`);--> statement-breakpoint
CREATE TABLE `checklist_items` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`text` text NOT NULL,
	`done` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `checklist_project` ON `checklist_items` (`project_id`,`position`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`status` text DEFAULT 'Queued' NOT NULL,
	`revision` text DEFAULT '' NOT NULL,
	`spool_id` text,
	`material` text DEFAULT '' NOT NULL,
	`grams` real,
	`minutes` real,
	`actual_minutes` real,
	`layer_height` text DEFAULT '' NOT NULL,
	`nozzle` text DEFAULT '' NOT NULL,
	`plate` text DEFAULT '' NOT NULL,
	`supports` text DEFAULT 'None' NOT NULL,
	`infill` integer,
	`notes` text DEFAULT '' NOT NULL,
	`printer_task` text DEFAULT '' NOT NULL,
	`charge_spool_id` text,
	`charge_grams` real DEFAULT 0 NOT NULL,
	`started_at` text,
	`finished_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`spool_id`) REFERENCES `spools`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`charge_spool_id`) REFERENCES `spools`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `jobs_project` ON `jobs` (`project_id`);--> statement-breakpoint
CREATE INDEX `jobs_status` ON `jobs` (`status`);--> statement-breakpoint
CREATE INDEX `jobs_printer_task` ON `jobs` (`printer_task`);--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`age` integer,
	`color` text NOT NULL,
	`interests` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "profiles_age" CHECK("profiles"."age" IS NULL OR ("profiles"."age" BETWEEN 0 AND 120))
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'Idea' NOT NULL,
	`category` text DEFAULT 'Home' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`url` text DEFAULT '' NOT NULL,
	`files` text DEFAULT '' NOT NULL,
	`material` text DEFAULT '' NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `projects_profile` ON `projects` (`profile_id`);--> statement-breakpoint
CREATE INDEX `projects_status` ON `projects` (`status`);--> statement-breakpoint
CREATE TABLE `spools` (
	`id` text PRIMARY KEY NOT NULL,
	`brand` text DEFAULT '' NOT NULL,
	`material` text NOT NULL,
	`color_name` text DEFAULT '' NOT NULL,
	`color_hex` text NOT NULL,
	`total_grams` real NOT NULL,
	`remaining_grams` real NOT NULL,
	`cost` real,
	`notes` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "spools_weights" CHECK("spools"."total_grams" > 0 AND "spools"."remaining_grams" >= 0 AND "spools"."remaining_grams" <= "spools"."total_grams")
);
