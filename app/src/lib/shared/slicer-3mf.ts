// Slicer projects as the browser lists them (slicer-3mf). The project itself is the Project model in
// shared/slicer/project.ts.
import type { MeshRef, Project } from './slicer/project';

export interface SlicerProjectSummary {
	id: string;
	projectId: string;
	name: string;
	/** Goes up on every save; send it back as If-Match to refuse overwriting someone else's save. */
	revision: number;
	createdAt: string;
	updatedAt: string;
	objects: number;
	parts: number;
	plates: number;
	/** The Title stored in the file. */
	title: string;
	/** Size of the .3mf. */
	bytes: number;
}

/** GET /api/slicer-projects/[id]. */
export interface SlicerProjectDetail extends SlicerProjectSummary {
	project: Project;
	/** What the reader had to work around in the file. */
	warnings: string[];
}

/** POST /api/slicer-projects/meshes. */
export type StoredMesh = MeshRef;
