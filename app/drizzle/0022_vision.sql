CREATE TABLE `vision_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`printer_id` text NOT NULL,
	`job_id` text,
	`task` text DEFAULT '' NOT NULL,
	`layer` integer,
	`total_layers` integer,
	`at` text NOT NULL,
	`verdict` text NOT NULL,
	`confidence` real DEFAULT 0 NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`provider` text NOT NULL,
	`frame_file` text,
	`alerted` integer DEFAULT false NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`error` text,
	FOREIGN KEY (`printer_id`) REFERENCES `printers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `vision_checks_printer` ON `vision_checks` (`printer_id`,`at`);
