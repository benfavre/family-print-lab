CREATE TABLE `printers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`model` text NOT NULL,
	`host` text NOT NULL,
	`serial` text NOT NULL,
	`access_code` text NOT NULL,
	`port` integer DEFAULT 8883 NOT NULL,
	`ftp_port` integer DEFAULT 990 NOT NULL,
	`tls` integer DEFAULT true NOT NULL,
	`simulated` integer DEFAULT false NOT NULL,
	`tls_pin` text,
	`enabled` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `printers_serial` ON `printers` (`serial`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `printer_id` text REFERENCES printers(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `jobs` ADD `dispatch` text;--> statement-breakpoint
CREATE INDEX `jobs_printer` ON `jobs` (`printer_id`);
