import type { MeshRef, Transform } from './project';
export type BooleanMode = 'union' | 'subtract' | 'intersect';
export interface BooleanRequest {
	first: { meshId: string; transform: Transform };
	second: { meshId: string; transform: Transform };
	mode: BooleanMode;
}
export interface BooleanAnswer {
	mesh: MeshRef;
}
