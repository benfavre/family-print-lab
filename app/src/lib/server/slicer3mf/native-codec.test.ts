// Exact behavioural comparison against the C++ preservation codec, without waiting for libslic3r.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { Project } from '$lib/shared/slicer/project';
import { readZip, writeZip } from '../cad/mesh';
import { read3mf } from './read';
import { write3mf } from './write';

const BIN = process.env.PRINTLAB_PROJECT_CODEC;
const dir = path.join(import.meta.dirname, '__fixtures__');
const fixtures = fs.readdirSync(dir).filter((name) => name.endsWith('.3mf'));

interface Output {
	project: Project;
	files: Record<string, string>;
	meshes: Record<string, string>;
}
function run(bytes: Buffer, project?: Project): Output {
	const files = Object.fromEntries(
		[...readZip(bytes, () => 'all')].map(([name, data]) => [name, data.toString('base64')])
	);
	return JSON.parse(
		execFileSync(BIN!, {
			input: JSON.stringify({ files, project }),
			maxBuffer: 128 * 1024 * 1024
		}).toString()
	);
}
function normalise(out: Output): Project {
	const p = structuredClone(out.project);
	const meshes: Project['meshes'] = {};
	for (const [id, m] of Object.entries(p.meshes)) {
		const hash = crypto
			.createHash('sha256')
			.update(Buffer.from(out.meshes[id], 'base64'))
			.digest('hex');
		meshes[hash] = { ...m, id: hash, storage: { kind: 'file', path: `${hash}.stl` } };
		for (const o of p.objects) for (const part of o.parts) if (part.mesh === id) part.mesh = hash;
	}
	p.meshes = meshes;
	return p;
}

describe.runIf(!!BIN)('native project preservation codec', () => {
	for (const name of fixtures) {
		it(`matches TypeScript and round-trips ${name}`, () => {
			const input = fs.readFileSync(path.join(dir, name));
			const reference = read3mf(input);
			const first = run(input);
			expect(normalise(first)).toEqual(reference.project);
			const written = writeZip(
				Object.entries(first.files).map(([n, b]) => [n, Buffer.from(b, 'base64')])
			);
			expect(read3mf(written).project).toEqual(reference.project);
			const tsWritten = write3mf(reference.project, {
				mesh: (id) => reference.meshes.get(id)!.geometry
			});
			expect(normalise(run(tsWritten))).toEqual(reference.project);
			for (const [file, entry] of Object.entries(reference.project.passthrough)) {
				if ('base64' in entry) expect(first.files[file], file).toBe(entry.base64);
			}
		}, 60_000);
	}
	it('writes edited names, transforms, settings and arbitrary binary attachments', () => {
		const input = fs.readFileSync(path.join(dir, 'synth-bambu-features.3mf'));
		const first = run(input);
		const edited = structuredClone(first.project);
		edited.meta.title = 'Edited & saved';
		edited.objects[0].name = 'Moved object';
		edited.objects[0].parts[0].name = 'Edited part';
		edited.objects[0].parts[0].config.custom_future_setting = 'keep <this>';
		edited.objects[0].instances[0].transform[9] += 12;
		edited.plates[0].name = 'Edited plate';
		edited.passthrough['Metadata/custom.bin'] = {
			base64: Buffer.from([0, 128, 255]).toString('base64')
		};
		const saved = run(input, edited);
		const written = writeZip(
			Object.entries(saved.files).map(([n, b]) => [n, Buffer.from(b, 'base64')])
		);
		expect(read3mf(written).project).toEqual(normalise(saved));
	});
});
