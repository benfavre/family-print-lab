// Full engine integration: project.open/save through JSON-RPC, against the TypeScript 3MF oracle.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Project } from '$lib/shared/slicer/project';
import { ERROR } from '$lib/shared/slicer/protocol';
import { read3mf } from '../slicer3mf/read';
import { write3mf } from '../slicer3mf/write';
import { StdioEngine } from './engine';

const BIN = process.env.PRINTLAB_SLICER_PATH;
const dir = path.resolve(import.meta.dirname, '../slicer3mf/__fixtures__');
const fixtures = fs.readdirSync(dir).filter((name) => name.endsWith('.3mf'));
function portable(project: Project): Project {
	const p = structuredClone(project);
	for (const mesh of Object.values(p.meshes))
		mesh.storage = { kind: 'file', path: `${mesh.id}.stl` };
	return p;
}

describe.runIf(!!BIN)('native project files', () => {
	for (const name of fixtures) {
		it(`round-trips ${name} in both directions`, { timeout: 180_000 }, async ({ skip }) => {
			const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fpl-project-é-印刷-'));
			const engine = await StdioEngine.open({ command: BIN!, workDir: work });
			try {
				if (!engine.has('slice')) skip(); // The protocol-only CI build has no upstream facade.
				expect(engine.has('project.open')).toBe(true);
				expect(engine.has('project.save')).toBe(true);
				const input = path.join(work, `modèle-${name}`);
				fs.copyFileSync(path.join(dir, name), input);
				const reference = read3mf(fs.readFileSync(input));
				const opened = await engine.call('project.open', { path: input });
				expect(portable(opened.project)).toEqual(reference.project);
				for (const mesh of Object.values(opened.project.meshes)) {
					expect(mesh.storage.kind).toBe('file');
					if (mesh.storage.kind === 'file')
						expect(fs.readFileSync(mesh.storage.path)).toEqual(reference.meshes.get(mesh.id)!.stl);
				}
				const output = path.join(work, 'enregistré-模型.3mf');
				await engine.call('project.save', { projectId: opened.projectId, path: output });
				expect(read3mf(fs.readFileSync(output)).project).toEqual(reference.project);
				const tsFile = path.join(work, 'typescript-é-印刷.3mf');
				fs.writeFileSync(
					tsFile,
					write3mf(reference.project, { mesh: (id) => reference.meshes.get(id)!.geometry })
				);
				const reopened = await engine.call('project.open', { path: tsFile });
				expect(portable(reopened.project)).toEqual(reference.project);
				await engine.call('project.save', { projectId: reopened.projectId, path: output });
				expect(read3mf(fs.readFileSync(output)).project).toEqual(reference.project);
				await engine.call('project.close', { projectId: opened.projectId });
				await engine.call('project.close', { projectId: reopened.projectId });
			} finally {
				await engine.close();
				fs.rmSync(work, { recursive: true, force: true });
			}
		});
	}
	it(
		'preserves invalid settings for editing but refuses to slice with defaults',
		{ timeout: 180_000 },
		async ({ skip }) => {
			const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fpl-project-invalid-'));
			const engine = await StdioEngine.open({ command: BIN!, workDir: work });
			try {
				if (!engine.has('slice')) skip();
				const reference = read3mf(fs.readFileSync(path.join(dir, 'synth-bambu-features.3mf')));
				reference.project.projectConfig.sparse_infill_density = '<25%>';
				const input = path.join(work, 'invalid.3mf');
				fs.writeFileSync(
					input,
					write3mf(reference.project, { mesh: (id) => reference.meshes.get(id)!.geometry })
				);
				const opened = await engine.call('project.open', { path: input });
				expect(portable(opened.project)).toEqual(reference.project);
				const output = path.join(work, 'saved.3mf');
				await engine.call('project.save', { projectId: opened.projectId, path: output });
				expect(read3mf(fs.readFileSync(output)).project).toEqual(reference.project);
				await expect(
					engine.call('slice', { projectId: opened.projectId, plate: 1 })
				).rejects.toMatchObject({ code: ERROR.INVALID_CONFIG });
			} finally {
				await engine.close();
				fs.rmSync(work, { recursive: true, force: true });
			}
		}
	);
});
