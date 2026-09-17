CREATE TABLE `keyframe_renders` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`script_id` text NOT NULL,
	`shot_id` integer NOT NULL,
	`source_key` text NOT NULL,
	`request` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`status` text NOT NULL,
	`task_id` text,
	`result_url` text,
	`asset_id` text,
	`error` text,
	`review` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `keyframe_workspaces` (
	`project_id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`document` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `scripts` ADD `narration_style` text;