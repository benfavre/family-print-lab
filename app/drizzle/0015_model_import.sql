CREATE TABLE `project_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`site` text NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`author` text,
	`author_url` text,
	`licence` text,
	`licence_url` text,
	`images` text DEFAULT '[]' NOT NULL,
	`imported_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_sources_project` ON `project_sources` (`project_id`);
