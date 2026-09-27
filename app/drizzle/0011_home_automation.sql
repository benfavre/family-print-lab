CREATE TABLE `plugs` (
	`id` text PRIMARY KEY NOT NULL,
	`printer_id` text NOT NULL REFERENCES printers(id) ON DELETE cascade,
	`kind` text NOT NULL,
	`config` text NOT NULL,
	`auto_on` integer DEFAULT true NOT NULL,
	`auto_off` integer DEFAULT false NOT NULL,
	`cooldown_minutes` integer DEFAULT 10 NOT NULL,
	`off_below_nozzle` integer DEFAULT 50 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugs_printer` ON `plugs` (`printer_id`);
