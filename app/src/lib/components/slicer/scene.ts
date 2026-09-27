// The workspace's 3D view: every plate of the project laid out as Bambu Studio does, each object
// instance with its parts (model parts in their filament colour, modifiers and other volumes see-
// through), a move/rotate/scale gizmo on the selection, picking, facet painting and "lay on face".
// Z is up, units are mm, positions are project coordinates. The maths lives in client/slicer; this
// only draws and reports. Renders on demand.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { PartType, Project, Transform } from '$lib/shared/slicer/project';
import type { BedShape } from '$lib/shared/slicer-ui';
import { fromMatrix4, toMatrix4, type Vec3 } from '$lib/client/slicer/matrix';
import { plateOrigin } from '$lib/client/slicer/plates';
import { partFilament } from '$lib/client/slicer/edit';
import type { Selection, Pick } from '$lib/client/slicer/selection';
import type { PaintKind } from '$lib/client/slicer/paint';
import { shownStates } from '$lib/client/slicer/paint';

export type Gizmo = 'translate' | 'rotate' | 'scale' | null;

export interface SceneEvents {
	onPick(pick: Pick | null, additive: boolean, partId: string | null): void;
	/** While dragging the gizmo (final: on release). */
	onTransform(pick: Pick, transform: Transform, final: boolean): void;
	/** A painting stroke hit a part's triangle (point in the mesh's own coordinates). */
	onPaint(
		hit: { objectId: string; partId: string; triangle: number; point: Vec3 },
		first: boolean
	): void;
	onPaintEnd(): void;
	/** Lay on face: a face was clicked (its world normal). */
	onFace(pick: Pick, normal: Vec3): void;
}

export interface PaintView {
	kind: PaintKind;
	/** Colours per painted state; state n of colour painting is filament n. */
	colours: Record<number, string>;
	objectId: string;
}

const PART_LOOK: Record<Exclude<PartType, 'model'>, { color: number; opacity: number }> = {
	modifier: { color: 0x39d98a, opacity: 0.35 },
	negative: { color: 0x9aa3b5, opacity: 0.35 },
	support_blocker: { color: 0xff4d6a, opacity: 0.4 },
	support_enforcer: { color: 0x3d8bff, opacity: 0.4 }
};

const rgb = (name: string, fallback: string) => {
	const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	return new THREE.Color(v ? `rgb(${v.split(/\s+/).join(',')})` : fallback);
};

interface PartMesh extends THREE.Mesh {
	userData: {
		objectId: string;
		instanceId: string;
		partId: string;
		meshId: string;
		type: PartType;
	};
}

export class SlicerScene {
	private renderer: THREE.WebGLRenderer;
	private scene = new THREE.Scene();
	private camera = new THREE.PerspectiveCamera(35, 1, 1, 20000);
	private controls: OrbitControls;
	private gizmo: TransformControls;
	private beds = new THREE.Group();
	private objects = new THREE.Group();
	private geometries = new Map<string, THREE.BufferGeometry>();
	private instances = new Map<string, THREE.Group>();
	private raycaster = new THREE.Raycaster();
	private observer: ResizeObserver;
	private frame = 0;
	private down: { x: number; y: number; button: number } | null = null;
	private painting = false;
	/** Whether the current stroke has painted yet (its first paint starts an undo step). */
	private stroked = false;
	private dragging = false;
	private bed: BedShape = { area: [0, 0, 256, 256], height: 250, printerModel: '' };
	private plates = 1;
	private project: Project | null = null;
	private selection: Selection = { items: [], partId: null };
	private paint: PaintView | null = null;
	private layFace = false;
	private gizmoMode: Gizmo = 'translate';
	private disposed = false;

	constructor(
		private host: HTMLElement,
		private events: SceneEvents
	) {
		this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
		this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
		this.renderer.domElement.className = 'slicer-canvas';
		host.appendChild(this.renderer.domElement);
		this.camera.up.set(0, 0, 1);
		this.controls = new OrbitControls(this.camera, this.renderer.domElement);
		this.controls.enableDamping = false;
		this.controls.screenSpacePanning = true;
		this.controls.addEventListener('change', () => this.render());

		this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
		this.gizmo.setSpace('world');
		this.gizmo.addEventListener('change', () => this.render());
		this.gizmo.addEventListener('dragging-changed', (e) => {
			this.dragging = !!(e as unknown as { value: boolean }).value;
			this.controls.enabled = !this.dragging;
		});
		this.gizmo.addEventListener('objectChange', () => this.reportGizmo(false));
		this.gizmo.addEventListener('mouseUp', () => this.reportGizmo(true));
		this.scene.add(this.gizmo.getHelper());

		this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404858, 1.6));
		const key = new THREE.DirectionalLight(0xffffff, 1.8);
		key.position.set(-400, -600, 900);
		this.scene.add(key);
		const rim = new THREE.DirectionalLight(0xffffff, 0.5);
		rim.position.set(600, 500, 300);
		this.scene.add(rim);
		this.scene.add(this.beds, this.objects);

		const el = this.renderer.domElement;
		el.addEventListener('pointerdown', (e) => this.pointerDown(e));
		el.addEventListener('pointermove', (e) => this.pointerMove(e));
		el.addEventListener('pointerup', (e) => this.pointerUp(e));
		el.addEventListener('contextmenu', (e) => e.preventDefault());
		this.observer = new ResizeObserver(() => this.resize());
		this.observer.observe(host);
		this.resize();
	}

	// ---------- Content ----------

	/** The meshes' triangles (shared by every part using a mesh). */
	setMesh(meshId: string, positions: Float32Array) {
		if (this.geometries.has(meshId)) return;
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
		g.computeVertexNormals();
		g.computeBoundingBox();
		this.geometries.set(meshId, g);
	}

	setBed(bed: BedShape, plates: number, active: number) {
		const changed =
			bed.area.join() !== this.bed.area.join() ||
			plates !== this.plates ||
			!this.beds.children.length;
		this.bed = bed;
		this.plates = plates;
		if (changed) this.buildBeds();
		this.beds.children.forEach((c, i) => {
			const on = i + 1 === active;
			(c.userData.plane as THREE.Mesh).material = on ? this.bedActive : this.bedIdle;
		});
		this.render();
	}

	private bedIdle = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.35 });
	private bedActive = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.6 });
	private gridMaterial = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.25 });

	private buildBeds() {
		for (const c of this.beds.children) c.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
		this.beds.clear();
		const [minX, minY, maxX, maxY] = this.bed.area;
		const w = maxX - minX,
			h = maxY - minY;
		const base = rgb('--raise', '#1c2230');
		this.bedIdle.color.copy(base);
		this.bedActive.color.copy(base).offsetHSL(0, 0, 0.06);
		this.gridMaterial.color.copy(rgb('--hi', '#ffffff'));
		for (let i = 1; i <= this.plates; i++) {
			const [ox, oy] = plateOrigin(this.bed, this.plates, i);
			const plate = new THREE.Group();
			plate.position.set(ox, oy, 0);
			const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), this.bedIdle);
			plane.position.set(minX + w / 2, minY + h / 2, -0.05);
			plane.userData.plate = i;
			const pts: number[] = [];
			for (let x = minX; x <= maxX + 0.01; x += 10) pts.push(x, minY, 0, x, maxY, 0);
			for (let y = minY; y <= maxY + 0.01; y += 10) pts.push(minX, y, 0, maxX, y, 0);
			const grid = new THREE.LineSegments(
				new THREE.BufferGeometry().setAttribute(
					'position',
					new THREE.Float32BufferAttribute(pts, 3)
				),
				this.gridMaterial
			);
			plate.add(plane, grid);
			plate.userData.plane = plane;
			this.beds.add(plate);
		}
	}

	/** Draws the project (call after every edit; unchanged meshes are reused). */
	setProject(project: Project, selection: Selection) {
		this.project = project;
		this.selection = selection;
		const colours = new Map(project.filaments.map((f) => [f.index, f.color]));
		const seen = new Set<string>();
		for (const obj of project.objects) {
			const selected = selection.items.some((i) => i.objectId === obj.id);
			for (const inst of obj.instances) {
				const key = `${obj.id}/${inst.id}`;
				seen.add(key);
				let group = this.instances.get(key);
				if (!group) {
					group = new THREE.Group();
					group.matrixAutoUpdate = false;
					this.instances.set(key, group);
					this.objects.add(group);
				}
				if (!this.dragging || !selected) {
					group.matrix.copy(toMatrix4(inst.transform));
					group.matrix.decompose(group.position, group.quaternion, group.scale);
				}
				group.userData = { objectId: obj.id, instanceId: inst.id };
				for (const c of [...group.children]) {
					group.remove(c);
					const m = c as THREE.Mesh;
					if (m.userData.ownGeometry) m.geometry.dispose();
					(m.material as THREE.Material).dispose();
				}
				for (const part of obj.parts) {
					const g = this.geometries.get(part.mesh);
					if (!g) continue;
					const painting = this.paint && this.paint.objectId === obj.id && part.type === 'model';
					const geometry = painting ? this.paintedGeometry(g, part.paint?.[this.paint!.kind]) : g;
					let material: THREE.Material;
					if (part.type === 'model') {
						const c = new THREE.Color(
							colours.get(partFilament(obj, part))?.slice(0, 7) ?? '#c8ccd4'
						);
						material = new THREE.MeshStandardMaterial({
							color: painting ? 0xffffff : c,
							vertexColors: !!painting,
							roughness: 0.6,
							metalness: 0.05,
							flatShading: true,
							emissive: selected && !painting ? new THREE.Color(0x2a5cff) : new THREE.Color(0),
							emissiveIntensity: selected ? 0.35 : 0
						});
					} else {
						const look = PART_LOOK[part.type];
						const active = selection.partId === part.id;
						material = new THREE.MeshStandardMaterial({
							color: look.color,
							transparent: true,
							opacity: active ? look.opacity + 0.25 : look.opacity,
							depthWrite: false,
							flatShading: true
						});
					}
					const mesh = new THREE.Mesh(geometry, material) as unknown as PartMesh;
					mesh.userData = {
						objectId: obj.id,
						instanceId: inst.id,
						partId: part.id,
						meshId: part.mesh,
						type: part.type
					};
					if (geometry !== g) (mesh.userData as Record<string, unknown>).ownGeometry = true;
					mesh.matrixAutoUpdate = false;
					mesh.matrix.copy(toMatrix4(part.transform));
					if (!obj.printable || !inst.printable)
						(material as THREE.MeshStandardMaterial).opacity = 0.4;
					if (!obj.printable || !inst.printable) material.transparent = true;
					group.add(mesh);
				}
				group.updateMatrixWorld(true);
			}
		}
		for (const [key, group] of this.instances)
			if (!seen.has(key)) {
				this.objects.remove(group);
				this.instances.delete(key);
			}
		this.attachGizmo();
		this.render();
	}

	/** A copy of a mesh with per-triangle colours for the painting being edited. */
	private paintedGeometry(base: THREE.BufferGeometry, strings: Record<number, string> | undefined) {
		const g = base.clone();
		const count = g.getAttribute('position').count;
		const colours = new Float32Array(count * 3);
		const plain = new THREE.Color(0xc8ccd4);
		for (let v = 0; v < count; v++) plain.toArray(colours, v * 3);
		const states = shownStates(strings);
		const c = new THREE.Color();
		for (const [tri, state] of states) {
			const css = this.paint?.colours[state];
			if (!css) continue;
			c.set(css.slice(0, 7));
			for (let k = 0; k < 3; k++) c.toArray(colours, (tri * 3 + k) * 3);
		}
		g.setAttribute('color', new THREE.BufferAttribute(colours, 3));
		return g;
	}

	setGizmo(mode: Gizmo, snap: { move: number; rotate: number; scale: number }) {
		this.gizmoMode = mode;
		this.gizmo.setTranslationSnap(snap.move || null);
		this.gizmo.setRotationSnap(snap.rotate ? (snap.rotate * Math.PI) / 180 : null);
		this.gizmo.setScaleSnap(snap.scale || null);
		this.attachGizmo();
	}

	setPaint(paint: PaintView | null) {
		this.paint = paint;
		this.controls.mouseButtons.LEFT = paint ? (null as unknown as THREE.MOUSE) : THREE.MOUSE.ROTATE;
		this.attachGizmo();
		if (this.project) this.setProject(this.project, this.selection);
	}

	setLayFace(on: boolean) {
		this.layFace = on;
		this.renderer.domElement.style.cursor = on ? 'crosshair' : '';
		this.attachGizmo();
	}

	private attachGizmo() {
		const one = this.selection.items.length === 1 ? this.selection.items[0] : null;
		const group = one ? this.instances.get(`${one.objectId}/${one.instanceId}`) : undefined;
		if (!group || !this.gizmoMode || this.paint || this.layFace) {
			this.gizmo.detach();
		} else {
			if (this.gizmo.object !== group) this.gizmo.attach(group);
			this.gizmo.setMode(this.gizmoMode);
		}
		this.render();
	}

	private reportGizmo(final: boolean) {
		const group = this.gizmo.object;
		if (!group) return;
		group.updateMatrix();
		const pick = { objectId: group.userData.objectId, instanceId: group.userData.instanceId };
		this.events.onTransform(pick, fromMatrix4(group.matrix), final);
	}

	// ---------- Pointer ----------

	private hitAt(e: PointerEvent) {
		const r = this.renderer.domElement.getBoundingClientRect();
		const ndc = new THREE.Vector2(
			((e.clientX - r.left) / r.width) * 2 - 1,
			-((e.clientY - r.top) / r.height) * 2 + 1
		);
		this.raycaster.setFromCamera(ndc, this.camera);
		const hits = this.raycaster.intersectObjects(this.objects.children, true);
		// Model parts first: a see-through modifier should not hide what is behind it when painting.
		return hits.find((h) => (h.object as PartMesh).userData.type === 'model') ?? hits[0] ?? null;
	}

	private pointerDown(e: PointerEvent) {
		this.down = { x: e.clientX, y: e.clientY, button: e.button };
		// A stroke starts anywhere and paints wherever it crosses the object.
		if (this.paint && e.button === 0) {
			this.painting = true;
			this.stroked = false;
			this.renderer.domElement.setPointerCapture(e.pointerId);
			this.strokeAt(e);
		}
	}

	private pointerMove(e: PointerEvent) {
		if (this.painting) this.strokeAt(e);
	}

	private strokeAt(e: PointerEvent) {
		const hit = this.hitAt(e);
		const data = (hit?.object as PartMesh | undefined)?.userData;
		if (!hit || !data || data.objectId !== this.paint?.objectId || data.type !== 'model') return;
		this.emitPaint(hit, !this.stroked);
		this.stroked = true;
	}

	private emitPaint(hit: THREE.Intersection, first: boolean) {
		const mesh = hit.object as PartMesh;
		const local = mesh.worldToLocal(hit.point.clone());
		this.events.onPaint(
			{
				objectId: mesh.userData.objectId,
				partId: mesh.userData.partId,
				triangle: hit.faceIndex ?? 0,
				point: [local.x, local.y, local.z]
			},
			first
		);
	}

	private pointerUp(e: PointerEvent) {
		if (this.painting) {
			this.painting = false;
			this.events.onPaintEnd();
			this.down = null;
			return;
		}
		const d = this.down;
		this.down = null;
		// A click, not the end of an orbit or a gizmo drag.
		if (!d || d.button !== 0 || this.dragging || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5)
			return;
		const hit = this.hitAt(e);
		const data = (hit?.object as PartMesh | undefined)?.userData;
		if (this.layFace && hit && data) {
			const n = hit.face!.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
			this.events.onFace({ objectId: data.objectId, instanceId: data.instanceId }, [n.x, n.y, n.z]);
			return;
		}
		if (this.paint) return;
		this.events.onPick(
			data ? { objectId: data.objectId, instanceId: data.instanceId } : null,
			e.shiftKey || e.ctrlKey || e.metaKey,
			data && data.type !== 'model' ? data.partId : null
		);
	}

	// ---------- Camera ----------

	/** Frames a plate from the front, a little above (Bambu Studio's default view). */
	focusPlate(index: number, view: 'iso' | 'top' = 'iso') {
		const [ox, oy] = plateOrigin(this.bed, this.plates, index);
		const [minX, minY, maxX, maxY] = this.bed.area;
		const c = new THREE.Vector3(ox + (minX + maxX) / 2, oy + (minY + maxY) / 2, 0);
		const size = Math.max(maxX - minX, maxY - minY);
		this.controls.target.copy(c);
		if (view === 'top') this.camera.position.set(c.x, c.y - 0.01, c.z + size * 2.1);
		else this.camera.position.set(c.x, c.y - size * 1.2, c.z + size * 0.95);
		this.controls.update();
		this.render();
	}

	/**
	 * A 512×512 PNG (base64) of a plate from above at an angle, for the printer's plate picture. Drawn at
	 * that size whatever the stage's size, so it works while the stage is hidden (the Preview tab).
	 */
	snapshot(index: number): string | null {
		const pos = this.camera.position.clone(),
			target = this.controls.target.clone();
		const ratio = this.renderer.getPixelRatio();
		const helper = this.gizmo.getHelper();
		const hadHelper = helper.visible;
		helper.visible = false;
		this.beds.visible = false;
		try {
			this.renderer.setPixelRatio(1);
			this.renderer.setSize(512, 512, false);
			this.camera.aspect = 1;
			this.camera.updateProjectionMatrix();
			this.focusPlate(index);
			this.renderer.render(this.scene, this.camera);
			// Read in the same task as the render: the drawing buffer is not kept after that.
			return this.renderer.domElement.toDataURL('image/png').split(',')[1] ?? null;
		} catch {
			return null;
		} finally {
			this.beds.visible = true;
			helper.visible = hadHelper;
			this.renderer.setPixelRatio(ratio);
			this.camera.position.copy(pos);
			this.controls.target.copy(target);
			this.controls.update();
			this.resize();
		}
	}

	refreshTheme() {
		this.buildBeds();
		this.render();
	}

	private resize() {
		const w = this.host.clientWidth || 1,
			h = this.host.clientHeight || 1;
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
		this.render();
	}

	render() {
		if (this.frame || this.disposed) return;
		this.frame = requestAnimationFrame(() => {
			this.frame = 0;
			this.renderer.render(this.scene, this.camera);
		});
	}

	dispose() {
		this.disposed = true;
		cancelAnimationFrame(this.frame);
		this.observer.disconnect();
		this.gizmo.dispose();
		this.controls.dispose();
		for (const g of this.geometries.values()) g.dispose();
		this.renderer.dispose();
		this.renderer.domElement.remove();
	}
}
