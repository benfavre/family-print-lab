import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { openDatabase } from './db';
import { Lab } from './lab';
import { SketchStore } from './sketches';
import { Backups } from './backup';
import { writeRequest } from './ai/write';

/** A minimal valid PNG of the given size (one colour). */
function png(width: number, height: number) {
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (b: Buffer) => {
		let c = 0xffffffff;
		for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type: string, data: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type), data]);
		const sum = Buffer.alloc(4);
		sum.writeUInt32BE(crc(body));
		return Buffer.concat([len, body, sum]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr.set([8, 2, 0, 0, 0], 8);
	const raw = Buffer.alloc((width * 3 + 1) * height, 255);
	return Buffer.concat([
		Buffer.from('89504e470d0a1a0a', 'hex'),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0))
	]);
}

describe('sketches', () => {
	const setup = () => {
		const db = openDatabase(':memory:');
		const lab = new Lab(db);
		const store = new SketchStore(db, lab);
		const projectId = lab.createProject({
			profileId: lab.createProfile({ name: 'Mia', color: 'pink' }),
			title: 'Lamp'
		});
		return { db, lab, store, projectId };
	};

	it('stores PNG sketches with their size, lists them in the workspace, and replaces or removes them', () => {
		const { lab, store, projectId } = setup();
		const id = store.create(projectId, png(40, 30), 'Side view');
		const listed = lab.snapshot().sketches;
		expect(listed).toEqual([
			expect.objectContaining({
				id,
				projectId,
				title: 'Side view',
				width: 40,
				height: 30,
				version: 1
			})
		]);
		expect(store.png(id).subarray(1, 4).toString()).toBe('PNG');
		store.update(id, png(80, 60));
		expect(lab.snapshot().sketches[0]).toMatchObject({ width: 80, height: 60, version: 2 });
		// A save that started from version 1 now conflicts instead of overwriting version 2.
		expect(() => store.update(id, png(20, 20), 1)).toThrow(/saved from somewhere else/);
		store.update(id, png(20, 20), 2);
		expect(lab.snapshot().sketches[0]).toMatchObject({ width: 20, version: 3 });
		expect(lab.snapshot().activity.some((a) => a.message.startsWith('Added a sketch'))).toBe(true);
		store.remove(id);
		expect(lab.snapshot().sketches).toEqual([]);
	});

	it('refuses things that are not PNG images and projects that do not exist', () => {
		const { store, projectId } = setup();
		expect(() => store.create(projectId, Buffer.from('not an image'))).toThrow(/PNG/);
		expect(() => store.create('missing', png(4, 4))).toThrow(/no longer exists/);
	});

	it('goes away with its project, and is included in database backups', async () => {
		const { db, lab, store, projectId } = setup();
		store.create(projectId, png(10, 10));
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'print-lab-sketch-backup-'));
		try {
			const backup = await new Backups(db, dir).create('test');
			const copy = openDatabase(path.join(dir, backup.file, 'printlab.db'));
			expect(new Lab(copy).snapshot().sketches).toHaveLength(1);
			copy.$client.close();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		lab.deleteProject(projectId);
		expect(lab.snapshot().sketches).toEqual([]);
	});
});

describe('AI writing help', () => {
	it('builds a focused request with the project context and refuses empty text where it needs some', () => {
		const req = writeRequest({
			action: 'flesh',
			field: 'The idea',
			text: 'lamp for reading',
			context: { Project: 'Reading lamp', For: 'Mia, age 9' }
		});
		expect(req.messages[0].content).toMatch(/Project: Reading lamp/);
		expect(req.messages[0].content).toMatch(/For: Mia, age 9/);
		expect(req.messages[0].content).toMatch(/practical brief/);
		expect(req.system).toMatch(/only the new text/);
		expect(() => writeRequest({ action: 'tidy', field: 'Notes', text: '  ' })).toThrow(
			/Write something first/
		);
		expect(() => writeRequest({ action: 'nonsense', field: 'x', text: 'y' })).toThrow();
	});
});
