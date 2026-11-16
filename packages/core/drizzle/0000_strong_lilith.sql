CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`provider_agent_id` text,
	`session_id` text NOT NULL,
	`device_id` text NOT NULL,
	`project_id` text,
	`parent_agent_id` text,
	`role` text NOT NULL,
	`name` text NOT NULL,
	`agent_type` text,
	`model` text,
	`status` text NOT NULL,
	`current_tool` text,
	`current_tool_use_id` text,
	`is_demo` integer DEFAULT false NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_event_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agents_provider_idx` ON `agents` (`provider_id`);--> statement-breakpoint
CREATE INDEX `agents_session_idx` ON `agents` (`session_id`);--> statement-breakpoint
CREATE INDEX `agents_project_idx` ON `agents` (`project_id`);--> statement-breakpoint
CREATE INDEX `agents_device_idx` ON `agents` (`device_id`);--> statement-breakpoint
CREATE INDEX `agents_parent_idx` ON `agents` (`parent_agent_id`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`is_demo` integer DEFAULT false NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_event_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_id` text NOT NULL,
	`device_id` text NOT NULL,
	`session_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`project_id` text,
	`event_type` text NOT NULL,
	`tool_name` text,
	`outcome` text,
	`detail` text,
	`file_path` text,
	`task_id` text,
	`provider_event_id` text,
	`dedup_key` text,
	`summary` text NOT NULL,
	`is_demo` integer DEFAULT false NOT NULL,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_dedup_uq` ON `events` (`dedup_key`);--> statement-breakpoint
CREATE INDEX `events_provider_idx` ON `events` (`provider_id`);--> statement-breakpoint
CREATE INDEX `events_agent_idx` ON `events` (`agent_id`);--> statement-breakpoint
CREATE INDEX `events_session_idx` ON `events` (`session_id`);--> statement-breakpoint
CREATE INDEX `events_project_idx` ON `events` (`project_id`);--> statement-breakpoint
CREATE INDEX `events_received_idx` ON `events` (`received_at`);--> statement-breakpoint
CREATE INDEX `events_device_idx` ON `events` (`device_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`is_demo` integer DEFAULT false NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_event_at` integer NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_device_path_uq` ON `projects` (`device_id`,`path`);--> statement-breakpoint
CREATE TABLE `providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_event_at` integer
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`provider_session_id` text NOT NULL,
	`device_id` text NOT NULL,
	`project_id` text,
	`model` text,
	`is_demo` integer DEFAULT false NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`first_seen_at` integer NOT NULL,
	`last_event_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_provider_idx` ON `sessions` (`provider_id`);--> statement-breakpoint
CREATE INDEX `sessions_project_idx` ON `sessions` (`project_id`);--> statement-breakpoint
CREATE INDEX `sessions_device_idx` ON `sessions` (`device_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_task_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`session_id` text NOT NULL,
	`agent_id` text,
	`project_id` text,
	`status` text NOT NULL,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` integer,
	`completed_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tasks_session_idx` ON `tasks` (`session_id`);--> statement-breakpoint
CREATE INDEX `tasks_agent_idx` ON `tasks` (`agent_id`);--> statement-breakpoint
CREATE INDEX `tasks_project_idx` ON `tasks` (`project_id`);