// Services that packages provide to each other (interfaces only). The package that implements one adds
// its ModuleServices entry by declaration merging in its own modules/<key>/module.ts, for example:
//
//   declare module '$lib/server/modules' {
//   	interface ModuleServices {
//   		camera: CameraService;
//   	}
//   }
//
// Others reach it with ctx.module('camera'), which may be undefined when the package is absent:
// degrade gracefully.
import type { CommandName } from '../printer/commands/registry';
import type { SlicerEngine } from '../slicer/engine';
import type { GlobalTray, HmsCode } from '$lib/shared/printers/status';
import type { ProfileService } from '$lib/shared/slicer/profiles';
import type { Project } from '$lib/shared/slicer/project';

/** camera */
export interface CameraService {
	has(printerId: string): boolean;
	/** A JPEG no older than maxAgeMs (default 2000), starting a short session when none runs. */
	getSnapshot(
		printerId: string,
		opts?: { maxAgeMs?: number; signal?: AbortSignal }
	): Promise<Buffer>;
}

/** hms */
export interface HmsService {
	describe(code: HmsCode | number, printerId: string): HmsInfo;
	active(printerId: string): HmsInfo[];
}
export interface HmsInfo {
	key: string;
	kind: 'hms' | 'print_error';
	severity: 'fatal' | 'serious' | 'common' | 'info' | 'unknown';
	module: string;
	text: string;
	wikiUrl: string | null;
	actions: HmsAction[];
}
export interface HmsAction {
	id: number;
	label: string;
	command: CommandName | null;
}

/** notifications */
export interface NotifyService {
	notify(message: {
		title: string;
		body: string;
		level: 'info' | 'success' | 'warning' | 'error';
		printerId?: string;
		link?: string;
		event?: string;
	}): void;
}

/** queue */
export interface QueueService {
	enqueue(jobId: string, opts?: { printerId?: string | null; notBefore?: string | null }): void;
	nextFor(printerId: string): { jobId: string } | null;
}

/** home-automation */
export interface PowerService {
	ensureOn(printerId: string, opts?: { signal?: AbortSignal }): Promise<void>;
}

/** ams */
export interface SpoolSyncService {
	spoolForTray(printerId: string, tray: GlobalTray): string | null;
}

/** slicer-profiles */
export interface ProfileServiceModule {
	profiles: ProfileService;
}

/** slicer-engine */
export interface SlicerServiceModule {
	open(): Promise<SlicerEngine | null>;
}

/** slicer-3mf */
export interface ProjectStoreService {
	load(slicerProjectId: string): Promise<Project>;
	save(slicerProjectId: string, project: Project): Promise<void>;
}
