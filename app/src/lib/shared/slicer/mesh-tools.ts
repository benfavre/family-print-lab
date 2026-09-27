import type { MeshRef, Transform } from './project';

export type CutAxis = 'x' | 'y' | 'z';
export type CutKeep = 'below' | 'above' | 'both';
export interface CutRequest {
	meshId: string;
	/** Part then instance transform; the plane is in project millimetres. */
	transform: Transform;
	axis: CutAxis;
	at: number;
	keep: CutKeep;
}
export interface CutAnswer {
	pieces: { side: 'below' | 'above'; mesh: MeshRef }[];
}
