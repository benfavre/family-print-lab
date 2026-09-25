// Model viewer: renders an STL on a to-scale Bambu Lab X2D bed with orbit controls, standard views,
// a section plane, measuring, and picking (a face to lay flat, a point to drill). Z is up, units are mm.
// The part is shown centred on the bed and resting on it, like a slicer places it; picks are reported
// in the model's own coordinates. Renders on demand, not every frame.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { BED, meshFacts } from './printcheck';
export { BED };
export type View = 'iso' | 'top' | 'front' | 'right';
export type PickMode = 'orbit' | 'measure' | 'face' | 'point';
export interface Measurement {
	distance: number;
	delta: [number, number, number];
}
export interface ViewerEvents {
	onMeasure?: (m: Measurement | null) => void;
	onFace?: (normal: [number, number, number]) => void;
	onPoint?: (point: [number, number, number], normal: [number, number, number]) => void;
}
/** Printability figures for the loaded part (areas in mm², volume in mm³). */
export interface Analysis {
	area: number;
	volume: number;
	overhangArea: number;
	/** Rough PLA weight in grams: 2 walls (≈0.84 mm shell) and 15 % infill. */
	grams: number;
	/** Edges not shared by exactly two faces (null: too dense to check). */
	openEdges: number | null;
	/** Area resting on the plate, mm². */
	contactArea: number;
}
export interface Bounds {
	min: [number, number, number];
	max: [number, number, number];
	size: [number, number, number];
}

const rgb = (name: string, fallback: string) => {
	const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	return new THREE.Color(v ? `rgb(${v.split(/\s+/).join(',')})` : fallback);
};

export { parseStl } from './stl';

export class ModelViewer {
	private renderer: THREE.WebGLRenderer;
	private scene = new THREE.Scene();
	private camera = new THREE.PerspectiveCamera(35, 1, 0.5, 5000);
	private controls: OrbitControls;
	private part = new THREE.Group();
	private bed = new THREE.Group();
	private overlay = new THREE.Group();
	private mesh: THREE.Mesh | null = null;
	private cap: THREE.Mesh | null = null;
	private edges: THREE.LineSegments | null = null;
	private material = new THREE.MeshStandardMaterial({
		roughness: 0.55,
		metalness: 0.08,
		flatShading: true
	});
	private capMaterial = new THREE.MeshBasicMaterial({ side: THREE.BackSide });
	private edgeMaterial = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.35 });
	private section = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
	private offset = new THREE.Vector3();
	private box = new THREE.Box3();
	private measurePoints: THREE.Vector3[] = [];
	private raycaster = new THREE.Raycaster();
	private frame = 0;
	private observer: ResizeObserver;
	private down: { x: number; y: number } | null = null;
	private overhangMask: Uint8Array | null = null;
	private stats: Analysis | null = null;
	overhangs = false;
	mode: PickMode = 'orbit';
	wireframe = false;

	constructor(
		private host: HTMLElement,
		private events: ViewerEvents = {}
	) {
		this.renderer = new THREE.WebGLRenderer({
			antialias: true,
			alpha: true,
			preserveDrawingBuffer: true
		});
		this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
		this.renderer.localClippingEnabled = true;
		this.renderer.domElement.className = 'viewer-canvas';
		host.appendChild(this.renderer.domElement);

		this.camera.up.set(0, 0, 1);
		this.controls = new OrbitControls(this.camera, this.renderer.domElement);
		this.controls.enableDamping = true;
		this.controls.dampingFactor = 0.12;
		this.controls.screenSpacePanning = true;
		this.controls.addEventListener('change', () => this.render());

		this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404858, 1.6));
		const key = new THREE.DirectionalLight(0xffffff, 1.8);
		key.position.set(-180, -260, 420);
		this.scene.add(key);
		const rim = new THREE.DirectionalLight(0xffffff, 0.6);
		rim.position.set(260, 200, 120);
		this.scene.add(rim);
		this.scene.add(this.bed, this.part, this.overlay);

		this.refreshTheme();
		this.setView('iso', false);

		const el = this.renderer.domElement;
		el.addEventListener('pointerdown', (e) => (this.down = { x: e.clientX, y: e.clientY }));
		el.addEventListener('pointerup', (e) => {
			// A click, not the end of an orbit drag.
			if (this.down && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) < 5)
				this.pick(e);
			this.down = null;
		});
		this.observer = new ResizeObserver(() => this.resize());
		this.observer.observe(host);
		this.resize();
	}

	// ---------- Content ----------

	/** Shows a mesh. keepCamera leaves the view alone (live preview while editing). */
	load(positions: Float32Array, keepCamera = false) {
		const before = this.mesh ? this.box.getSize(new THREE.Vector3()).length() : 0;
		this.clearPart();
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
		geometry.computeVertexNormals();
		geometry.computeBoundingBox();
		this.box.copy(geometry.boundingBox!);
		this.analyse(positions);
		geometry.setAttribute(
			'color',
			new THREE.BufferAttribute(new Float32Array(positions.length), 3)
		);
		const center = this.box.getCenter(new THREE.Vector3());
		this.offset.set(-center.x, -center.y, -this.box.min.z);

		this.mesh = new THREE.Mesh(geometry, this.material);
		this.cap = new THREE.Mesh(geometry, this.capMaterial);
		this.cap.visible = false;
		this.part.add(this.mesh, this.cap);
		// Crease lines give a crisp CAD look; skipped on very dense meshes where they cost too much.
		if (positions.length / 9 < 250_000) {
			this.edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 28), this.edgeMaterial);
			this.part.add(this.edges);
		}
		this.part.position.copy(this.offset);
		this.material.wireframe = this.wireframe;
		this.paint();
		this.clearMeasure();
		const after = this.box.getSize(new THREE.Vector3()).length();
		// Keep the user's view during live edits unless the part grew or shrank a lot.
		if (!keepCamera) this.setView('iso');
		else if (before && (after > before * 1.2 || after < before * 0.5)) this.fit();
		this.render();
	}

	clearPart() {
		for (const obj of [this.mesh, this.edges]) obj?.geometry.dispose();
		this.part.clear();
		this.mesh = this.cap = this.edges = null;
		this.render();
	}

	get hasPart() {
		return !!this.mesh;
	}

	analysis(): Analysis | null {
		return this.stats;
	}

	/** Paints faces that need support (steeper than 45° and not resting on the bed). */
	setOverhangs(on: boolean) {
		this.overhangs = on;
		this.paint();
		this.render();
	}

	/** Bounds in model coordinates. */
	bounds(): Bounds | null {
		if (!this.mesh) return null;
		const { min, max } = this.box;
		return {
			min: [min.x, min.y, min.z],
			max: [max.x, max.y, max.z],
			size: [max.x - min.x, max.y - min.y, max.z - min.z]
		};
	}

	// ---------- View ----------

	setView(view: View, animate = true) {
		const size = this.mesh
			? this.box.getSize(new THREE.Vector3())
			: new THREE.Vector3(120, 120, 60);
		const radius = Math.max(size.length() / 2, 30);
		const dist = (radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.45;
		const target = new THREE.Vector3(0, 0, size.z / 2);
		const dir = {
			iso: new THREE.Vector3(-0.9, -1.4, 1.05),
			top: new THREE.Vector3(0, -0.0001, 1),
			front: new THREE.Vector3(0, -1, 0.02),
			right: new THREE.Vector3(1, 0, 0.02)
		}[view].normalize();
		const to = target.clone().add(dir.multiplyScalar(dist));
		cancelAnimationFrame(this.frame);
		if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
			this.camera.position.copy(to);
			this.controls.target.copy(target);
			this.controls.update();
			return this.render();
		}
		const fromPos = this.camera.position.clone(),
			fromTarget = this.controls.target.clone();
		const start = performance.now();
		const step = (now: number) => {
			const t = Math.min(1, (now - start) / 420);
			const e = 1 - Math.pow(1 - t, 3);
			this.camera.position.lerpVectors(fromPos, to, e);
			this.controls.target.lerpVectors(fromTarget, target, e);
			this.controls.update();
			this.render();
			if (t < 1) this.frame = requestAnimationFrame(step);
		};
		this.frame = requestAnimationFrame(step);
	}

	/** Re-frames the part from the current viewing direction. */
	fit() {
		const size = this.box.getSize(new THREE.Vector3());
		const dist =
			(Math.max(size.length() / 2, 30) / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2))) *
			1.45;
		const dir = this.camera.position.clone().sub(this.controls.target).normalize();
		this.controls.target.set(0, 0, size.z / 2);
		this.camera.position.copy(this.controls.target).add(dir.multiplyScalar(dist));
		this.controls.update();
		this.render();
	}

	setWireframe(on: boolean) {
		this.wireframe = on;
		this.material.wireframe = on;
		if (this.edges) this.edges.visible = !on;
		this.render();
	}

	/** Cuts the view at a height (model coordinates) to look inside; null shows the whole part. */
	setSection(z: number | null) {
		if (z !== null) this.section.constant = z + this.offset.z;
		// Moving the plane is cheap; switching clipping on or off recompiles shaders, so only do that on change.
		const on = z !== null;
		if (on !== this.sectionOn) {
			this.sectionOn = on;
			const planes = on ? [this.section] : [];
			this.material.clippingPlanes = planes;
			this.capMaterial.clippingPlanes = planes;
			this.edgeMaterial.clippingPlanes = planes;
			this.material.needsUpdate =
				this.capMaterial.needsUpdate =
				this.edgeMaterial.needsUpdate =
					true;
		}
		if (this.cap) this.cap.visible = on;
		this.render();
	}

	// ---------- Showcase (the page visualizers) ----------

	/**
	 * Turns the viewer into a display piece: slow turntable, drag to spin, no zoom or pan (so the page
	 * still scrolls), and a continuous animation loop.
	 */
	setShowcase(options: { rotate: boolean; onLayer?: (layer: number, total: number) => void }) {
		this.showcase = true;
		this.onLayer = options.onLayer;
		this.controls.enableZoom = false;
		this.controls.enablePan = false;
		// On touch screens a swipe over the page header must scroll the page, not spin the part.
		if (matchMedia('(pointer: coarse)').matches) {
			this.controls.enableRotate = false;
			this.renderer.domElement.style.touchAction = 'pan-y';
		}
		this.controls.autoRotate = options.rotate;
		this.controls.autoRotateSpeed = 1.1;
		this.volume.visible = false;
		cancelAnimationFrame(this.loop);
		const tick = (t: number) => {
			this.loop = requestAnimationFrame(tick);
			this.advancePrint(t);
			this.controls.update();
			this.renderer.render(this.scene, this.camera);
		};
		this.loop = requestAnimationFrame(tick);
	}

	/**
	 * Shows the part being printed up to a fraction of its height (0–1), easing towards it; null plays a
	 * looping layer-by-layer preview. Heights are reported as 0.2 mm layers.
	 */
	setPrintProgress(progress: number | null) {
		this.printTarget = progress === null ? null : Math.max(0, Math.min(1, progress));
		this.printStart = performance.now();
		if (this.printTarget === null) this.printShown = 0;
	}

	/** Shows where a cut will happen (model coordinates), or hides it. */
	setCutPreview(
		cut: { axis: 'x' | 'y' | 'z'; at: number; keep: 'below' | 'above' | 'both' } | null
	) {
		this.overlay.getObjectByName('cut')?.removeFromParent();
		if (cut && this.mesh) {
			const size = this.box.getSize(new THREE.Vector3()).multiplyScalar(1.25).addScalar(10);
			const group = new THREE.Group();
			group.name = 'cut';
			const dims = { x: [size.y, size.z], y: [size.x, size.z], z: [size.x, size.y] }[cut.axis];
			const plane = new THREE.Mesh(
				new THREE.PlaneGeometry(dims[0], dims[1]),
				new THREE.MeshBasicMaterial({
					color: this.hot,
					transparent: true,
					opacity: 0.22,
					side: THREE.DoubleSide,
					depthWrite: false
				})
			);
			const outline = new THREE.LineSegments(
				new THREE.EdgesGeometry(plane.geometry),
				new THREE.LineBasicMaterial({ color: this.hot })
			);
			plane.add(outline);
			if (cut.axis === 'x') plane.rotation.set(Math.PI / 2, Math.PI / 2, 0);
			if (cut.axis === 'y') plane.rotation.set(Math.PI / 2, 0, 0);
			const c = this.box.getCenter(new THREE.Vector3());
			c[cut.axis] = cut.at;
			plane.position.copy(c).add(this.offset);
			group.add(plane);
			this.overlay.add(group);
		}
		this.render();
	}

	/** Shows a drill preview through the part at a point (model coordinates), or hides it. */
	setDrillPreview(drill: { x: number; y: number; diameter: number } | null) {
		this.overlay.getObjectByName('drill')?.removeFromParent();
		if (drill && this.mesh) {
			const h = this.box.max.z - this.box.min.z + 10;
			const cyl = new THREE.Mesh(
				new THREE.CylinderGeometry(drill.diameter / 2, drill.diameter / 2, h, 40),
				new THREE.MeshBasicMaterial({
					color: this.hot,
					transparent: true,
					opacity: 0.45,
					depthWrite: false
				})
			);
			cyl.name = 'drill';
			cyl.rotation.x = Math.PI / 2;
			cyl.position.set(drill.x, drill.y, (this.box.min.z + this.box.max.z) / 2).add(this.offset);
			this.overlay.add(cyl);
		}
		this.render();
	}

	/**
	 * Shows extra geometry (e.g. letters about to be added), given in its own coordinates plus a
	 * column-major 4×4 placement in model coordinates; null hides it.
	 */
	setGhost(positions: Float32Array | null, matrix?: number[]) {
		const old = this.overlay.getObjectByName('ghost') as THREE.Mesh | undefined;
		old?.geometry.dispose();
		old?.removeFromParent();
		if (positions && matrix && this.mesh) {
			const geometry = new THREE.BufferGeometry();
			geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
			geometry.computeVertexNormals();
			const ghost = new THREE.Mesh(
				geometry,
				new THREE.MeshStandardMaterial({
					color: this.hot,
					roughness: 0.5,
					flatShading: true,
					transparent: true,
					opacity: 0.85
				})
			);
			ghost.name = 'ghost';
			ghost.matrixAutoUpdate = false;
			ghost.matrix
				.fromArray(matrix)
				.premultiply(
					new THREE.Matrix4().makeTranslation(this.offset.x, this.offset.y, this.offset.z)
				);
			this.overlay.add(ghost);
		}
		this.render();
	}

	/** Overlays another version, see-through, each centred on the bed like the slicer would place it. */
	setCompare(positions: Float32Array | null) {
		const old = this.overlay.getObjectByName('compare') as THREE.Mesh | undefined;
		old?.geometry.dispose();
		old?.removeFromParent();
		if (positions && this.mesh) {
			const geometry = new THREE.BufferGeometry();
			geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
			geometry.computeVertexNormals();
			geometry.computeBoundingBox();
			const b = geometry.boundingBox!;
			const ghost = new THREE.Mesh(
				geometry,
				new THREE.MeshBasicMaterial({
					color: this.hot,
					transparent: true,
					opacity: 0.28,
					depthWrite: false,
					side: THREE.DoubleSide
				})
			);
			ghost.add(
				new THREE.LineSegments(
					new THREE.EdgesGeometry(geometry, 28),
					new THREE.LineBasicMaterial({ color: this.hot, transparent: true, opacity: 0.7 })
				)
			);
			ghost.name = 'compare';
			ghost.position.set(-(b.min.x + b.max.x) / 2, -(b.min.y + b.max.y) / 2, -b.min.z);
			ghost.renderOrder = 5;
			this.overlay.add(ghost);
		}
		this.render();
	}

	setMode(mode: PickMode) {
		this.mode = mode;
		this.renderer.domElement.dataset.mode = mode;
		if (mode !== 'measure') this.clearMeasure();
	}

	clearMeasure() {
		this.measurePoints = [];
		this.overlay.getObjectByName('measure')?.removeFromParent();
		this.events.onMeasure?.(null);
		this.render();
	}

	// ---------- Output ----------

	/** A PNG thumbnail from the standard iso view (the user's camera is restored afterwards). */
	async thumbnail(width = 480, height = 360): Promise<Blob | null> {
		if (!this.mesh) return null;
		const pos = this.camera.position.clone(),
			target = this.controls.target.clone();
		const overlays = this.overlay.visible;
		this.overlay.visible = false;
		this.setView('iso', false);
		const src = this.renderer.domElement;
		const out = document.createElement('canvas');
		out.width = width;
		out.height = height;
		const ctx = out.getContext('2d')!;
		const scale = Math.max(width / src.width, height / src.height);
		ctx.drawImage(
			src,
			(width - src.width * scale) / 2,
			(height - src.height * scale) / 2,
			src.width * scale,
			src.height * scale
		);
		this.overlay.visible = overlays;
		this.camera.position.copy(pos);
		this.controls.target.copy(target);
		this.controls.update();
		this.render();
		return new Promise((resolve) => out.toBlob(resolve, 'image/png'));
	}

	refreshTheme() {
		const accent = rgb('--c1', '#5ee7ff');
		const ink = rgb('--ink', '#96c8ff');
		this.hot = rgb('--c4', '#ffb454');
		this.material.color.copy(accent).lerp(new THREE.Color(0xffffff), 0.18);
		this.capMaterial.color.copy(this.hot);
		this.accent.copy(this.material.color);
		this.warn = rgb('--c5', '#ff6b7a');
		this.paint();
		this.edgeMaterial.color.copy(accent).multiplyScalar(0.35);
		this.bed.clear();
		// Build plate: 256 × 256 mm with 10 mm grid, a frame, and a faint volume outline (260 mm tall).
		const plate = new THREE.Mesh(
			new THREE.PlaneGeometry(BED.x, BED.y),
			new THREE.MeshBasicMaterial({
				color: ink,
				transparent: true,
				opacity: 0.045,
				depthWrite: false
			})
		);
		plate.position.z = -0.05;
		const grid = new THREE.GridHelper(BED.x, BED.x / 10, ink, ink);
		grid.rotation.x = Math.PI / 2;
		for (const m of [grid.material].flat())
			Object.assign(m, { transparent: true, opacity: 0.13, depthWrite: false });
		const volume = new THREE.LineSegments(
			new THREE.EdgesGeometry(new THREE.BoxGeometry(BED.x, BED.y, BED.z)),
			new THREE.LineBasicMaterial({ color: ink, transparent: true, opacity: 0.1 })
		);
		volume.position.z = BED.z / 2;
		const frame = new THREE.LineSegments(
			new THREE.EdgesGeometry(new THREE.PlaneGeometry(BED.x, BED.y)),
			new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.5 })
		);
		this.volume.clear();
		this.volume.add(volume);
		this.bed.add(plate, grid, this.volume, frame);
		this.render();
	}

	dispose() {
		cancelAnimationFrame(this.frame);
		cancelAnimationFrame(this.loop);
		this.observer.disconnect();
		this.controls.dispose();
		this.clearPart();
		this.renderer.dispose();
		this.renderer.domElement.remove();
	}

	// ---------- Internals ----------

	private hot = new THREE.Color('#ffb454');
	private sectionOn = false;
	private showcase = false;
	private loop = 0;
	private onLayer?: (layer: number, total: number) => void;
	private printTarget: number | null = null;
	private printShown = 1;
	private printStart = 0;
	private lastLayer = -1;
	private volume = new THREE.Group();

	/** One animation step of the print preview (showcase only). */
	private advancePrint(now: number) {
		if (!this.mesh) return;
		const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
		let p: number;
		if (this.printTarget !== null) {
			// Real progress: ease towards it.
			this.printShown += (this.printTarget - this.printShown) * (reduced ? 1 : 0.08);
			p = this.printShown;
		} else if (reduced) p = 1;
		else {
			// Preview: print for 9 s, show the finished part for 3 s, repeat.
			const t = ((now - this.printStart) % 12000) / 9000;
			p = Math.min(1, t);
		}
		const h = this.box.max.z - this.box.min.z;
		this.setSection(p >= 0.999 ? null : this.box.min.z + Math.max(p, 0.002) * h);
		const total = Math.max(1, Math.round(h / 0.2));
		const layer = Math.round(Math.min(1, p) * total);
		if (layer !== this.lastLayer) {
			this.lastLayer = layer;
			this.onLayer?.(layer, total);
		}
	}
	private accent = new THREE.Color('#8eeaff');
	private warn = new THREE.Color('#ff6b7a');

	private analyse(p: Float32Array) {
		const n = p.length / 9;
		const mask = new Uint8Array(n);
		const bedZ = this.box.min.z + 0.3;
		const limit = -Math.cos(Math.PI / 4);
		let area = 0,
			overhang = 0,
			volume = 0;
		for (let i = 0; i < n; i++) {
			const o = i * 9;
			const ax = p[o + 3] - p[o],
				ay = p[o + 4] - p[o + 1],
				az = p[o + 5] - p[o + 2];
			const bx = p[o + 6] - p[o],
				by = p[o + 7] - p[o + 1],
				bz = p[o + 8] - p[o + 2];
			const cx = ay * bz - az * by,
				cy = az * bx - ax * bz,
				cz = ax * by - ay * bx;
			const len = Math.hypot(cx, cy, cz);
			if (!len) continue;
			const a = len / 2;
			area += a;
			volume +=
				(p[o] * (p[o + 4] * p[o + 8] - p[o + 5] * p[o + 7]) -
					p[o + 1] * (p[o + 3] * p[o + 8] - p[o + 5] * p[o + 6]) +
					p[o + 2] * (p[o + 3] * p[o + 7] - p[o + 4] * p[o + 6])) /
				6;
			if (cz / len < limit && Math.min(p[o + 2], p[o + 5], p[o + 8]) > bedZ) {
				mask[i] = 1;
				overhang += a;
			}
		}
		volume = Math.abs(volume);
		const shell = Math.min(volume, area * 0.84);
		this.overhangMask = mask;
		this.stats = {
			area,
			volume,
			overhangArea: overhang,
			grams: ((shell + 0.15 * (volume - shell)) * 1.24) / 1000,
			...meshFacts(p)
		};
	}

	private paint() {
		const color = this.mesh?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
		this.material.vertexColors = this.overhangs && !!color;
		this.material.color.set(this.overhangs ? 0xffffff : this.accent);
		this.material.needsUpdate = true;
		if (!color || !this.overhangMask || !this.overhangs) return;
		const arr = color.array as Float32Array;
		for (let i = 0; i < this.overhangMask.length; i++) {
			const c = this.overhangMask[i] ? this.warn : this.accent;
			for (let v = 0; v < 3; v++) {
				arr[i * 9 + v * 3] = c.r;
				arr[i * 9 + v * 3 + 1] = c.g;
				arr[i * 9 + v * 3 + 2] = c.b;
			}
		}
		color.needsUpdate = true;
	}
	private pending = false;

	private render() {
		if (this.pending || this.showcase) return;
		this.pending = true;
		requestAnimationFrame(() => {
			this.pending = false;
			// Damping keeps the controls moving for a few frames after a drag.
			if (this.controls.update()) this.render();
			this.renderer.render(this.scene, this.camera);
		});
	}

	private resize() {
		const { clientWidth: w, clientHeight: h } = this.host;
		if (!w || !h) return;
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
		this.renderer.render(this.scene, this.camera);
	}

	private pick(e: PointerEvent) {
		if (this.mode === 'orbit' || !this.mesh) return;
		const rect = this.renderer.domElement.getBoundingClientRect();
		const ndc = new THREE.Vector2(
			((e.clientX - rect.left) / rect.width) * 2 - 1,
			-((e.clientY - rect.top) / rect.height) * 2 + 1
		);
		this.raycaster.setFromCamera(ndc, this.camera);
		const hit = this.raycaster
			.intersectObject(this.mesh, false)
			.find(
				(h) => !this.material.clippingPlanes?.length || this.section.distanceToPoint(h.point) >= 0
			);
		if (!hit) return;
		const local = hit.point.clone().sub(this.offset);
		if (this.mode === 'face' && hit.face) {
			const n = hit.face.normal;
			this.events.onFace?.([n.x, n.y, n.z]);
		} else if (this.mode === 'point') {
			const n = hit.face?.normal ?? new THREE.Vector3(0, 0, 1);
			this.events.onPoint?.([local.x, local.y, local.z], [n.x, n.y, n.z]);
		} else if (this.mode === 'measure') {
			if (this.measurePoints.length >= 2) this.measurePoints = [];
			this.measurePoints.push(hit.point.clone());
			this.drawMeasure();
		}
	}

	private drawMeasure() {
		this.overlay.getObjectByName('measure')?.removeFromParent();
		const group = new THREE.Group();
		group.name = 'measure';
		const size = Math.max(this.box.getSize(new THREE.Vector3()).length() / 120, 0.6);
		for (const p of this.measurePoints) {
			const dot = new THREE.Mesh(
				new THREE.SphereGeometry(size, 16, 12),
				new THREE.MeshBasicMaterial({ color: this.hot, depthTest: false })
			);
			dot.position.copy(p);
			dot.renderOrder = 10;
			group.add(dot);
		}
		if (this.measurePoints.length === 2) {
			const [a, b] = this.measurePoints;
			const line = new THREE.Line(
				new THREE.BufferGeometry().setFromPoints([a, b]),
				new THREE.LineBasicMaterial({ color: this.hot, depthTest: false })
			);
			line.renderOrder = 10;
			group.add(line);
			const d = b.clone().sub(a);
			this.events.onMeasure?.({
				distance: d.length(),
				delta: [Math.abs(d.x), Math.abs(d.y), Math.abs(d.z)]
			});
		} else this.events.onMeasure?.(null);
		this.overlay.add(group);
		this.render();
	}
}
