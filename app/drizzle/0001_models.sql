CREATE TABLE `model_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`model_id` text NOT NULL,
	`number` integer NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`params` text DEFAULT '{}' NOT NULL,
	`file` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`origin` text DEFAULT 'editor' NOT NULL,
	`triangles` integer DEFAULT 0 NOT NULL,
	`size_x` real DEFAULT 0 NOT NULL,
	`size_y` real DEFAULT 0 NOT NULL,
	`size_z` real DEFAULT 0 NOT NULL,
	`volume` real DEFAULT 0 NOT NULL,
	`has_thumbnail` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `model_versions_model` ON `model_versions` (`model_id`,`number`);--> statement-breakpoint
CREATE TABLE `models` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`current_version_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `models_project` ON `models` (`project_id`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `model_version_id` text REFERENCES model_versions(id);