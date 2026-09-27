// The workbench's bundled OpenSCAD text renderer, placed in project coordinates and then combined
// in the selected mesh's local space. Neither modelling nor font rendering leaves the machine.
import { textFrame, textScad } from '$lib/shared/cad';
import type { TextRequest } from '$lib/shared/slicer/text';
import type { Transform } from '$lib/shared/slicer/project';
import { renderScad } from '../../cad/openscad';
import type { Soup } from '../../cad/mesh';
import { AppError } from '../../validation';
import { booleanMesh } from './boolean';
import { load, toSolid, type Solid } from './mesh-tools';

export async function textMesh(soup: Soup, request: Omit<TextRequest, 'meshId'>): Promise<Soup> {
	const rendered = await renderScad(
		textScad(request.text, request.font, request.size, request.depth, request.mode)
	);
	if (!rendered.soup) throw new AppError(400, 'Those letters could not be made.');
	const frame = textFrame(request.point, request.normal, request.angle);
	const transform = [
		frame[0],
		frame[1],
		frame[2],
		frame[4],
		frame[5],
		frame[6],
		frame[8],
		frame[9],
		frame[10],
		frame[12],
		frame[13],
		frame[14]
	] as Transform;
	const result = await booleanMesh(
		soup,
		rendered.soup,
		request.transform,
		transform,
		request.mode === 'emboss' ? 'union' : 'subtract'
	);
	const w = await load();
	const original = toSolid(w, soup);
	let edited: Solid | undefined;
	try {
		edited = toSolid(w, result);
		if (
			Math.abs(edited.volume() - original.volume()) <
			Math.max(1e-8, Math.abs(original.volume()) * 1e-8)
		)
			throw new AppError(400, 'The text does not touch the object. Choose a face on the model.');
		if (request.mode === 'emboss') {
			const components = edited.decompose();
			try {
				for (const component of components) {
					const contact = component.intersect(original);
					try {
						if (contact.isEmpty())
							throw new AppError(
								400,
								'Some letters do not touch the object. Move the text or make it smaller.'
							);
					} finally {
						contact.delete();
					}
				}
			} finally {
				components.forEach((component) => component.delete());
			}
		}
		return result;
	} finally {
		edited?.delete();
		original.delete();
	}
}
