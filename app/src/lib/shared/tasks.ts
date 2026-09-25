// Long-running work (AI designs and edits, Blender jobs and sessions) as tasks whose progress is pushed
// to every open tab.
import type { AiProviderId } from './integrations';
import type { CadSuggestion } from './cad';

export type TaskKind =
	'ai-design' | 'ai-edit' | 'blender-repair' | 'blender-decimate' | 'blender-session';
export type TaskStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface TaskInfo {
	id: string;
	kind: TaskKind;
	title: string;
	projectId: string | null;
	modelId: string | null;
	provider: AiProviderId | null;
	status: TaskStatus;
	/** What is happening right now, e.g. "Checking the design (attempt 2)". */
	stage: string;
	startedAt: string;
	finishedAt: string | null;
	error: string | null;
	/** AI designs and edits: the suggestion, until someone uses it. */
	suggestion: CadSuggestion | null;
	/** Set once a suggestion has been turned into a model or version. */
	usedBy: string | null;
	/** Blender jobs: the version they created. */
	versionId: string | null;
}

export const TASK_ACTIVE = (t: TaskInfo) => t.status === 'running';
