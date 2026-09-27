// Everything the slicer workspace page shares between its panels: the project being edited (SlicerDoc),
// what the backend can do, the chosen printer's bed, the active plate, the selection, the tool in use,
// the sliced plates, and the actions that talk to the server. Panels get this object and call its
// methods; the page only lays them out.
import type { LabStore, UiState } from '../app.svelte';
import { meshFormat } from '../models';
import type { ConfigMap, Project, Transform } from '$lib/shared/slicer/project';
import type { ResolvedBundle } from '$lib/shared/slicer/profiles';
import type { SlicerProjectDetail } from '$lib/shared/slicer-3mf';
import type {
	ArrangeAnswer,
	BedShape,
	OrientAnswer,
	ResultsView,
	SendAnswer,
	SliceProgress,
	SlicerBackend
} from '$lib/shared/slicer-ui';
import type { EngineCapability } from '$lib/shared/slicer/protocol';
import { PAINT_ENFORCER, type PaintState } from '$lib/shared/slicer/paint';
import { SlicerDoc } from './doc.svelte';
import { getBackend, getBed, getResults, loadMesh, putMesh, putModelMesh } from './api';
import {
	addObject,
	addPart,
	applyArrange,
	applyOrient,
	duplicateObjects,
	findObject,
	instanceBox,
	instanceCentre,
	placeInstance,
	removeObjects,
	type Primitive
} from './edit';
import { compose, decompose, dropToBed, layOnFace, type Vec3 } from './matrix';
import { plateOf } from './plates';
import {
	EMPTY_SELECTION,
	pruneSelection,
	selectPlate,
	type Pick,
	type Selection
} from './selection';
import {
	adjacency,
	brushTriangles,
	fillTriangles,
	paintWith,
	shownStates,
	type PaintKind,
	type PaintTool
} from './paint';
import { binaryStl, primitiveSoup, PRIMITIVE_LABEL } from './primitives';
import { plateResult } from './results';

export type Gizmo = 'translate' | 'rotate' | 'scale' | null;

export interface PaintSettings {
	kind: PaintKind;
	tool: PaintTool;
	/** Supports/seam: 1 enforce, 2 block; colour: the filament; fuzzy skin: 1; 0 erases. */
	state: PaintState;
	/** Brush radius, mm. */
	radius: number;
	/** Smart fill edge angle, degrees. */
	angle: number;
}

const DEFAULT_BED: BedShape = { area: [0, 0, 256, 256], height: 250, printerModel: '' };

export class WorkspaceState {
	doc: SlicerDoc;
	backend = $state<SlicerBackend | null>(null);
	bed = $state<BedShape>(DEFAULT_BED);
	plate = $state(1);
	selection = $state.raw<Selection>(EMPTY_SELECTION);
	/** The printer the project is for (its trays colour the filaments; Send goes there). */
	printerId = $state<string | null>(null);
	results = $state.raw<ResultsView | null>(null);
	/** The values the presets give (placeholders in the settings panels). */
	defaults = $state.raw<ConfigMap>({});
	gizmo = $state<Gizmo>('translate');
	snapping = $state(true);
	layFace = $state(false);
	paint = $state<PaintSettings | null>(null);
	tab = $state<'prepare' | 'preview'>('prepare');
	/** Loaded mesh triangles by mesh id; `meshVersion` goes up when one arrives. */
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- large buffers; meshVersion signals changes
	meshes = new Map<string, Float32Array>();
	meshVersion = $state(0);
	/** The slice task running from here, and its progress. */
	sliceTask = $state<string | null>(null);
	progress = $state<{ percent: number; message: string } | null>(null);
	/** Instance being dragged with the gizmo: its live transform for the numbers panel. */
	dragging = $state.raw<{ pick: Pick; transform: Transform } | null>(null);
	busy = $state('');
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- bookkeeping, never rendered
	private neighbours = new Map<string, Int32Array[]>();
	private stopLive: (() => void) | null = null;

	constructor(
		readonly id: string,
		readonly projectId: string,
		detail: SlicerProjectDetail,
		private lab: LabStore,
		private ui: UiState
	) {
		this.doc = new SlicerDoc(id, detail.project, detail.revision);
		this.stopLive = lab.onLive<SliceProgress>('slicer-ui:progress', (d) => {
			if (d.slicerProjectId === this.id && d.taskId === this.sliceTask)
				this.progress = { percent: d.percent, message: d.message };
		});
	}

	get project(): Project {
		return this.doc.project;
	}

	can = (cap: EngineCapability) => !!this.backend?.capabilities.includes(cap);
	meshSource = (id: string) => this.meshes.get(id);

	async start() {
		const [backend, results] = await Promise.all([
			getBackend().catch(() => null),
			getResults(this.id).catch(() => null)
		]);
		this.backend = backend;
		this.results = results;
		await this.refreshBed();
		void this.loadMeshes();
	}

	async refreshBed() {
		this.bed = await getBed(this.project.presets.printer).catch(() => DEFAULT_BED);
	}

	/** The flat config of the chosen presets (slicer-profiles), for placeholders. */
	async refreshDefaults() {
		const sel = this.project.presets;
		if (
			!this.backend?.profiles ||
			!sel.printer.name ||
			!sel.process.name ||
			!sel.filaments.length
		) {
			this.defaults = {};
			return;
		}
		const asSystem = (r: typeof sel.printer) =>
			r.source === 'project' ? { ...r, source: 'system' as const } : r;
		const r = await fetch('/api/slicer/profiles/bundle', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				selection: {
					printer: asSystem(sel.printer),
					process: asSystem(sel.process),
					filaments: sel.filaments.map(asSystem)
				}
			})
		}).catch(() => null);
		this.defaults = r?.ok ? ((await r.json()) as ResolvedBundle).full : {};
	}

	async refreshResults() {
		this.results = await getResults(this.id).catch(() => this.results);
	}

	/** Loads every mesh the project uses that is not loaded yet. */
	async loadMeshes() {
		const want = Object.keys(this.project.meshes).filter((m) => !this.meshes.has(m));
		await Promise.all(
			want.map(async (m) => {
				try {
					this.meshes.set(m, await loadMesh(m));
					this.meshVersion++;
				} catch (e) {
					this.ui.toast((e as Error).message, 'error');
				}
			})
		);
	}

	dispose() {
		this.stopLive?.();
		this.doc.dispose();
	}

	// ---------- Edits ----------

	/** One undoable change; problems are shown, not thrown. */
	change(label: string, fn: (draft: Project) => void, merge = false): boolean {
		try {
			this.doc.edit(label, fn, merge);
		} catch (e) {
			this.ui.toast((e as Error).message, 'error');
			return false;
		}
		this.selection = pruneSelection(this.project, this.selection);
		if (!this.project.plates.some((p) => p.index === this.plate))
			this.plate = this.project.plates[0].index;
		void this.loadMeshes();
		return true;
	}

	select(sel: Selection) {
		this.selection = sel;
		// Selecting something on another plate makes that plate the active one.
		const first = sel.items[0];
		const plate = first ? plateOf(this.project, first.objectId, first.instanceId) : null;
		if (plate !== null) this.plate = plate;
	}

	selectAll() {
		this.selection = selectPlate(this.project, this.plate);
	}

	async addModel(modelId: string, versionId: string, name: string) {
		this.busy = 'Adding the model…';
		try {
			const mesh = await putModelMesh(modelId, versionId);
			this.change(`Add ${name}`, (p) => {
				const obj = addObject(p, { name, mesh, plate: this.plate, bed: this.bed });
				this.selection = {
					items: [{ objectId: obj.id, instanceId: obj.instances[0].id }],
					partId: null
				};
			});
		} catch (e) {
			this.ui.toast((e as Error).message, 'error');
		} finally {
			this.busy = '';
		}
	}

	async addFile(file: File) {
		const format = meshFormat(file.name);
		if (!format) return this.ui.toast('Choose an STL, 3MF or OBJ file.', 'error');
		if (file.size > 100_000_000) return this.ui.toast('Model files must be under 100 MB.', 'error');
		this.busy = 'Adding the file…';
		try {
			const mesh = await putMesh(file, format);
			const name = file.name.replace(/\.[^.]+$/, '').slice(0, 120) || 'Imported part';
			this.change(`Add ${name}`, (p) => {
				const obj = addObject(p, { name, mesh, plate: this.plate, bed: this.bed });
				this.selection = {
					items: [{ objectId: obj.id, instanceId: obj.instances[0].id }],
					partId: null
				};
			});
		} catch (e) {
			this.ui.toast((e as Error).message, 'error');
		} finally {
			this.busy = '';
		}
	}

	/** Adds a generated modifier (box, cylinder, sphere) to the selected object, sized to it. */
	async addPrimitive(
		kind: Primitive,
		type: 'modifier' | 'negative' | 'support_blocker' | 'support_enforcer' = 'modifier'
	) {
		const pick = this.selection.items[0];
		if (!pick) return this.ui.toast('Select an object first.', 'error');
		const obj = findObject(this.project, pick.objectId);
		const b = instanceBox(this.project, obj, obj.parts[0].transform, this.meshSource);
		const size: [number, number, number] = [
			Math.max(2, Math.round((b[3] - b[0]) * 0.5)),
			Math.max(2, Math.round((b[4] - b[1]) * 0.5)),
			Math.max(2, Math.round((b[5] - b[2]) * 0.5))
		];
		const soup = primitiveSoup(kind, size);
		try {
			const mesh = await putMesh(binaryStl(soup), 'stl');
			this.meshes.set(mesh.id, soup);
			this.meshVersion++;
			this.change(`Add ${PRIMITIVE_LABEL[kind].toLowerCase()}`, (p) => {
				const part = addPart(p, pick.objectId, {
					name: PRIMITIVE_LABEL[kind],
					type,
					mesh,
					primitive: { kind, size },
					meshes: this.meshSource
				});
				this.selection = { items: [pick], partId: part.id };
			});
		} catch (e) {
			this.ui.toast((e as Error).message, 'error');
		}
	}

	/** Adds a part from a file (a modifier or negative shape of your own) to the selected object. */
	async addPartFile(
		file: File,
		type: 'modifier' | 'negative' | 'support_blocker' | 'support_enforcer' | 'model'
	) {
		const pick = this.selection.items[0];
		const format = meshFormat(file.name);
		if (!pick) return this.ui.toast('Select an object first.', 'error');
		if (!format) return this.ui.toast('Choose an STL, 3MF or OBJ file.', 'error');
		try {
			const mesh = await putMesh(file, format);
			const name = file.name.replace(/\.[^.]+$/, '').slice(0, 120) || 'Part';
			this.change(`Add ${name}`, (p) => {
				const part = addPart(p, pick.objectId, { name, type, mesh, meshes: this.meshSource });
				this.selection = { items: [pick], partId: part.id };
			});
		} catch (e) {
			this.ui.toast((e as Error).message, 'error');
		}
	}

	deleteSelection() {
		const ids = this.selection.items.map((i) => i.objectId);
		if (!ids.length) return;
		this.change(ids.length > 1 ? `Delete ${ids.length} objects` : 'Delete object', (p) =>
			removeObjects(p, ids)
		);
		this.selection = EMPTY_SELECTION;
	}

	duplicateSelection() {
		const ids = this.selection.items.map((i) => i.objectId);
		if (!ids.length) return;
		this.change('Copy', (p) => {
			const made = duplicateObjects(p, ids);
			this.selection = {
				items: made.map((id) => ({ objectId: id, instanceId: `${id}-i1` })),
				partId: null
			};
		});
	}

	/** Sets an instance's transform (the gizmo let go, or numbers typed in). */
	setTransform(pick: Pick, transform: Transform, label = 'Move') {
		this.dragging = null;
		this.change(label, (p) =>
			placeInstance(p, this.bed, pick.objectId, pick.instanceId, transform, this.meshSource)
		);
	}

	/** Drops the selection onto the bed (lowest point at 0). */
	dropSelection() {
		const items = this.selection.items;
		if (!items.length) return;
		this.change('Drop to bed', (p) => {
			for (const it of items) {
				const obj = findObject(p, it.objectId);
				const inst = obj.instances.find((i) => i.id === it.instanceId);
				if (!inst) continue;
				inst.transform = dropToBed(
					inst.transform,
					instanceBox(p, obj, inst.transform, this.meshSource)[2]
				);
			}
		});
	}

	/** Lay on face: turns the instance so the clicked face rests on the bed. */
	layOn(pick: Pick, normal: Vec3) {
		this.layFace = false;
		this.change('Lay on face', (p) => {
			const obj = findObject(p, pick.objectId);
			const inst = obj.instances.find((i) => i.id === pick.instanceId);
			if (!inst) return;
			const turned = layOnFace(
				inst.transform,
				normal,
				instanceCentre(p, obj, inst.transform, this.meshSource)
			);
			inst.transform = dropToBed(turned, instanceBox(p, obj, turned, this.meshSource)[2]);
		});
		this.selection = { items: [pick], partId: null };
	}

	/** Saves first; the engine works on the saved project. */
	private async saved(): Promise<number | null> {
		const ok = await this.doc.save();
		if (!ok) {
			this.ui.toast(this.doc.problem || 'Save the project first.', 'error');
			return null;
		}
		return this.doc.revision;
	}

	async arrange(all = false) {
		const revision = await this.saved();
		if (revision === null) return;
		this.busy = all ? 'Arranging every plate…' : 'Arranging the plate…';
		const r = await this.lab.call<ArrangeAnswer>('POST', `/api/slicer-ui/${this.id}/arrange`, {
			plate: all ? 'all' : this.plate,
			revision
		});
		this.busy = '';
		if (r) this.change('Arrange', (p) => applyArrange(p, r));
	}

	async orient() {
		const ids = this.selection.items.length
			? this.selection.items.map((i) => i.objectId)
			: selectPlate(this.project, this.plate).items.map((i) => i.objectId);
		if (!ids.length) return this.ui.toast('There is nothing to orient on this plate.', 'error');
		const revision = await this.saved();
		if (revision === null) return;
		this.busy = 'Finding the best way up…';
		const r = await this.lab.call<OrientAnswer>('POST', `/api/slicer-ui/${this.id}/orient`, {
			objectIds: ids,
			revision
		});
		this.busy = '';
		if (r) this.change('Orient', (p) => applyOrient(p, r));
	}

	// ---------- Painting ----------

	/** One step of a painting stroke on a part's triangle. */
	paintAt(
		hit: { objectId: string; partId: string; triangle: number; point: Vec3 },
		first: boolean
	) {
		const settings = this.paint;
		if (!settings) return;
		const obj = this.project.objects.find((o) => o.id === hit.objectId);
		const part = obj?.parts.find((p) => p.id === hit.partId);
		const positions = part && this.meshes.get(part.mesh);
		if (!obj || !part || !positions) return;
		let triangles: number[];
		if (settings.tool === 'brush') {
			// The brush radius is in bed millimetres; the mesh may be scaled.
			const s = decompose(compose(part.transform, obj.instances[0].transform)).scale;
			const scale = (Math.abs(s[0]) + Math.abs(s[1]) + Math.abs(s[2])) / 3 || 1;
			triangles = brushTriangles(positions, hit.triangle, hit.point, settings.radius / scale);
		} else {
			if (!first) return;
			let n = this.neighbours.get(part.mesh);
			if (!n) this.neighbours.set(part.mesh, (n = adjacency(positions)));
			const states = shownStates(part.paint?.[settings.kind]);
			triangles = fillTriangles(
				positions,
				n,
				hit.triangle,
				settings.tool === 'edge' ? settings.angle : null,
				(t) => states.get(t) ?? 0
			);
		}
		const label = settings.state === 0 ? 'Erase painting' : 'Paint';
		this.change(
			label,
			(p) => {
				const target = findObject(p, hit.objectId).parts.find((x) => x.id === hit.partId)!;
				const paint = paintWith(target, settings.kind, triangles, settings.state);
				if (paint) target.paint = paint;
				else delete target.paint;
			},
			!first
		);
	}

	/** Clears one kind of painting on the painted object. */
	clearPaint(objectId: string, kind: PaintKind) {
		this.change('Clear painting', (p) => {
			for (const part of findObject(p, objectId).parts) {
				if (!part.paint?.[kind]) continue;
				delete part.paint[kind];
				if (!Object.keys(part.paint).length) delete part.paint;
			}
		});
	}

	startPaint(kind: PaintKind) {
		this.layFace = false;
		this.paint = {
			kind,
			tool: 'brush',
			state: kind === 'color' ? 1 : PAINT_ENFORCER,
			radius: 2,
			angle: 30
		};
	}

	// ---------- Slice, preview, send ----------

	plateResult(plate = this.plate) {
		return plateResult(this.results, plate, this.doc.dirty ? null : this.doc.revision);
	}

	async slice(thumbnail: string | null) {
		const revision = await this.saved();
		if (revision === null) return;
		this.progress = { percent: 0, message: 'Starting…' };
		const plate = this.plate;
		const r = await this.lab.call<{ task: { id: string } }>(
			'POST',
			`/api/slicer-ui/${this.id}/slice`,
			{
				plate,
				revision,
				thumbnail
			}
		);
		if (!r) {
			this.progress = null;
			return;
		}
		this.sliceTask = r.task.id;
		this.ui.watching.add(r.task.id);
		const done = await this.lab.waitForTask(r.task.id);
		if (this.sliceTask === r.task.id) {
			this.sliceTask = null;
			this.progress = null;
		}
		if (done.status === 'failed') this.ui.toast(done.error ?? 'Slicing failed.', 'error');
		await this.refreshResults();
		if (done.status === 'done' && this.plate === plate) this.tab = 'preview';
	}

	async cancelSlice() {
		if (this.sliceTask) await this.lab.taskAction(this.sliceTask, 'cancel');
	}

	/** Sends the active plate: to the queue, or as a job with the send window open. */
	async send(queue: boolean) {
		const r = await this.lab.call<SendAnswer>(
			'POST',
			`/api/slicer-ui/${this.id}/send`,
			{ plate: this.plate, printerId: this.printerId, queue },
			queue ? 'Added to the print queue.' : undefined
		);
		if (r && !r.queued) this.ui.openSend(r.jobId, this.printerId);
		return r;
	}
}
