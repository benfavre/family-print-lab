import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readZip, writeZip } from '../cad/mesh';
import { read3mf } from './read';
import { write3mf } from './write';
import { studioLayerProfile } from './layer-profile';

const HEIGHTS = 'Metadata/layer_heights_profile.txt';
const LAB = 'Metadata/print_lab.json';
function archive(profile: number[]) {
	const source = read3mf(
		fs.readFileSync(path.join(import.meta.dirname, '__fixtures__/synth-bambu-features.3mf'))
	);
	source.project.objects[0].layerHeightProfile = profile;
	return {
		source,
		bytes: write3mf(source.project, { mesh: (id) => source.meshes.get(id)!.geometry })
	};
}
const zip = (files: Map<string, Buffer>) => writeZip([...files]);

describe('two-point layer profiles', () => {
	it.each([
		[0, 0.2, 20, 0.2],
		[0, 0.2, 20, 0.1],
		[0, 0.123456789012, 19.9, 0.234567890123]
	])('round-trips exactly and exports a Studio-readable interpolation: %j', (...profile) => {
		const { source, bytes } = archive(profile);
		expect(read3mf(bytes).project).toEqual(source.project);
		const files = readZip(bytes, () => 'all');
		const expanded = studioLayerProfile(profile);
		expect(expanded).toHaveLength(6);
		expect(files.get(HEIGHTS)?.toString()).toContain(`object_id=1|${expanded.join(';')}`);
		expect(JSON.parse(files.get(LAB)!.toString()).layerHeightProfiles[0]).toEqual(profile);
		files.delete(LAB);
		expect(read3mf(zip(files)).project.objects[0].layerHeightProfile).toEqual(expanded);
	});
	it('reads historical two-point files without dropping their profile', () => {
		const profile = [0, 0.2, 20, 0.1];
		const files = readZip(archive(profile).bytes, () => 'all');
		files.delete(LAB);
		files.set(HEIGHTS, Buffer.from(`object_id=1|${profile.join(';')}\n`));
		const read = read3mf(zip(files));
		expect(read.project.objects[0].layerHeightProfile).toEqual(profile);
		expect(read.warnings).not.toContain('Layer height profile 1 skipped.');
	});
	it('keeps another editor’s changed or deleted side-file profile despite old private metadata', () => {
		const files = readZip(archive([0, 0.2, 20, 0.1]).bytes, () => 'all');
		const edited = [0, 0.2, 10, 0.18, 20, 0.1];
		files.set(HEIGHTS, Buffer.from(`object_id=1|${edited.join(';')}\n`));
		expect(read3mf(zip(files)).project.objects[0].layerHeightProfile).toEqual(edited);
		files.delete(HEIGHTS);
		expect(read3mf(zip(files)).project.objects[0].layerHeightProfile).toBeUndefined();
	});
});
