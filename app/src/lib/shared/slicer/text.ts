import type { TextFont } from '../cad';
import type { Transform } from './project';
export interface TextPlacement {
	objectId: string;
	instanceId: string;
	partId: string;
	point: [number, number, number];
	normal: [number, number, number];
}
export interface TextRequest {
	meshId: string;
	transform: Transform;
	text: string;
	font: TextFont;
	size: number;
	depth: number;
	mode: 'emboss' | 'engrave';
	point: [number, number, number];
	normal: [number, number, number];
	angle: number;
}
