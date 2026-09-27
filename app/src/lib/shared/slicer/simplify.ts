import type { MeshRef } from './project';

export interface SimplifyAnswer {
	mesh: MeshRef;
	before: number;
	after: number;
}
