CREATE TABLE `user_presets` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`inherits` text,
	`config` text DEFAULT '{}' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_presets_kind_name` ON `user_presets` (`kind`,`name`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `slice_overrides` text;--> statement-breakpoint
ALTER TABLE `spools` ADD `filament_preset` text;
