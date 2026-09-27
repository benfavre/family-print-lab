// Toolpath viewer: every segment of a plate as one three.js LineSegments (the preview's position array
// is used as it is: x0 y0 z0 x1 y1 z1 per segment is two vertices), coloured per vertex. Segments are
// in print order and layers are contiguous, so a layer range is a draw range; hidden features get alpha
// 0 and are discarded. The top visible layer can also be drawn as solid lines (boxes as wide and tall as
// the extrusion). Z is up, units are mm, printer coordinates. Renders on demand.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { PreviewData } from '$lib/shared/slicer/preview';

export type GcodeView = 'iso' | 'top' | 'front';

/** More solid segments than this in one layer are drawn as lines only. */
const SOLID_LIMIT = 150_000;
/** sRGB byte → linear byte: vertex colours are linear, the preview's colours are sRGB. */
const LINEAR = Uint8Array.from({ length: 256 }, (_, i) => {
	const c = i / 255;
	return Math.round((c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * 255);
});

export class GcodeViewer {
	private renderer: THREE.WebGLRenderer;
	private scene = new THREE.Scene();
	private camera = new THREE.PerspectiveCamera(35, 1, 0.5, 8000);
	private controls: OrbitControls;
	private lines: THREE.LineSegments | null = null;
	private colours: THREE.BufferAttribute | null = null;
	private lineMaterial = new THREE.LineBasicMaterial({ vertexColors: true });
	private solid: THREE.InstancedMesh | null = null;
	private solidMaterial = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.05 });
	private nozzle: THREE.Mesh;
	private grid = new THREE.Group();
	private data: PreviewData | null = null;
	private box = new THREE.Box3();
	private range = { from: 0, to: 0, moves: 0, solid: false };
	private observer: ResizeObserver;
	private frame = 0;
	private disposed = false;

	constructor(private host: HTMLElement) {
		this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
		this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
		this.renderer.domElement.className = 'gcode-canvas';
		host.appendChild(this.renderer.domElement);
		this.camera.up.set(0, 0, 1);
		this.controls = new OrbitControls(this.camera, this.renderer.domElement);
		this.controls.enableDamping = false;
		this.controls.screenSpacePanning = true;
		this.controls.addEventListener('change', () => this.render());
		// Hidden features have alpha 0. three.js never sets the alphaTest uniform for line materials
		// (WebGLMaterials.refreshUniformsLine), so the discard is written into the shader instead.
		this.lineMaterial.onBeforeCompile = (shader) => {
			shader.fragmentShader = shader.fragmentShader.replace(
				'#include <alphatest_fragment>',
				'if ( diffuseColor.a < 0.5 ) discard;'
			);
		};
		this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404858, 1.8));
		const key = new THREE.DirectionalLight(0xffffff, 1.6);
		key.position.set(-180, -260, 420);
		this.scene.add(key, this.grid);
		this.nozzle = new THREE.Mesh(
			new THREE.ConeGeometry(1.4, 4, 16).rotateX(-Math.PI / 2).translate(0, 0, 2),
			new THREE.MeshBasicMaterial({ color: 0xffffff })
		);
		this.nozzle.visible = false;
		this.scene.add(this.nozzle);
		this.observer = new ResizeObserver(() => this.resize());
		this.observer.observe(host);
		this.resize();
	}

	load(data: PreviewData) {
		this.clear();
		this.data = data;
		const n = data.header.segments;
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.BufferAttribute(data.seg, 3));
		this.colours = new THREE.BufferAttribute(new Uint8Array(n * 8), 4, true);
		geometry.setAttribute('color', this.colours);
		this.lines = new THREE.LineSegments(geometry, this.lineMaterial);
		this.lines.frustumCulled = false;
		this.scene.add(this.lines);
		const [x0, y0, z0, x1, y1, z1] = data.header.bbox;
		this.box.set(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, Math.max(z1, z0 + 1)));
		this.buildGrid();
		this.setView('iso');
	}

	/** Per-vertex sRGB + alpha from segmentColours(). */
	setColours(rgba: Uint8Array) {
		if (!this.colours) return;
		const out = this.colours.array as Uint8Array;
		for (let i = 0; i < rgba.length; i += 4) {
			out[i] = LINEAR[rgba[i]];
			out[i + 1] = LINEAR[rgba[i + 1]];
			out[i + 2] = LINEAR[rgba[i + 2]];
			out[i + 3] = rgba[i + 3];
		}
		this.colours.needsUpdate = true;
		this.updateSolid();
		this.render();
	}

	/** Shows layers from..to (inclusive) and the first `moves` segments of the top one. */
	setRange(from: number, to: number, moves: number, solid: boolean) {
		this.range = { from, to, moves, solid };
		const layers = this.data?.header.layers;
		if (!this.lines || !layers?.length) return;
		const start = layers[from].first;
		const end = layers[to].first + Math.min(moves, layers[to].count);
		this.lines.geometry.setDrawRange(start * 2, Math.max(0, end - start) * 2);
		// The nozzle sits at the end of the last shown move while scrubbing through a layer.
		const partial = moves < layers[to].count && end > start;
		this.nozzle.visible = partial;
		if (partial) {
			const s = this.data!.seg;
			this.nozzle.position.set(s[end * 6 - 3], s[end * 6 - 2], s[end * 6 - 1]);
		}
		this.updateSolid();
		this.render();
	}

	private updateSolid() {
		this.solid?.geometry.dispose();
		this.solid?.removeFromParent();
		this.solid?.dispose();
		this.solid = null;
		const data = this.data;
		const layer = data?.header.layers[this.range.to];
		if (!data || !layer || !this.range.solid || !this.colours) return;
		const rgba = this.colours.array as Uint8Array;
		const end = layer.first + Math.min(this.range.moves, layer.count);
		const picks: number[] = [];
		for (let i = layer.first; i < end && picks.length < SOLID_LIMIT; i++)
			if (data.attr[i * 4 + 2] > 0 && rgba[i * 8 + 3] > 0) picks.push(i);
		if (!picks.length) return;
		const mesh = new THREE.InstancedMesh(
			new THREE.BoxGeometry(1, 1, 1),
			this.solidMaterial,
			picks.length
		);
		const m = new THREE.Matrix4(),
			q = new THREE.Quaternion(),
			a = new THREE.Vector3(),
			b = new THREE.Vector3(),
			mid = new THREE.Vector3(),
			scale = new THREE.Vector3(),
			dir = new THREE.Vector3(),
			x = new THREE.Vector3(1, 0, 0),
			colour = new THREE.Color();
		picks.forEach((i, k) => {
			a.fromArray(data.seg, i * 6);
			b.fromArray(data.seg, i * 6 + 3);
			const width = data.attr[i * 4 + 2] / 100,
				height = Math.max(0.05, data.attr[i * 4 + 3] / 100);
			dir.subVectors(b, a);
			const length = dir.length();
			q.setFromUnitVectors(x, length > 0 ? dir.normalize() : x);
			// Extrusions sit below the nozzle: the box's top is the segment.
			mid
				.addVectors(a, b)
				.multiplyScalar(0.5)
				.setZ((a.z + b.z) / 2 - height / 2);
			scale.set(length + width * 0.6, width, height);
			m.compose(mid, q, scale);
			mesh.setMatrixAt(k, m);
			colour.setRGB(
				rgba[i * 8] / 255,
				rgba[i * 8 + 1] / 255,
				rgba[i * 8 + 2] / 255,
				THREE.LinearSRGBColorSpace
			);
			mesh.setColorAt(k, colour);
		});
		mesh.frustumCulled = false;
		this.solid = mesh;
		this.scene.add(mesh);
	}

	setView(view: GcodeView) {
		const center = this.box.getCenter(new THREE.Vector3());
		const size = this.box.getSize(new THREE.Vector3());
		const radius = Math.max(size.length() / 2, 10);
		const distance = radius / Math.sin((this.camera.fov * Math.PI) / 360);
		const dir =
			view === 'top'
				? new THREE.Vector3(0, -0.001, 1)
				: view === 'front'
					? new THREE.Vector3(0, -1, 0.12)
					: new THREE.Vector3(-0.8, -1.1, 0.95);
		this.camera.position.copy(center).addScaledVector(dir.normalize(), distance);
		this.controls.target.copy(center);
		this.controls.update();
		this.render();
	}

	/** A 10 mm grid under the toolpaths, a little larger than them. */
	private buildGrid() {
		this.grid.clear();
		const b = this.box;
		const x0 = Math.floor(b.min.x / 10) * 10 - 10,
			x1 = Math.ceil(b.max.x / 10) * 10 + 10;
		const y0 = Math.floor(b.min.y / 10) * 10 - 10,
			y1 = Math.ceil(b.max.y / 10) * 10 + 10;
		const points: number[] = [];
		for (let x = x0; x <= x1; x += 10) points.push(x, y0, 0, x, y1, 0);
		for (let y = y0; y <= y1; y += 10) points.push(x0, y, 0, x1, y, 0);
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
		this.grid.add(
			new THREE.LineSegments(
				geometry,
				new THREE.LineBasicMaterial({ color: 0x8090a8, transparent: true, opacity: 0.18 })
			)
		);
	}

	private clear() {
		this.lines?.geometry.dispose();
		this.lines?.removeFromParent();
		this.lines = null;
		this.colours = null;
		this.data = null;
		this.updateSolid();
		this.nozzle.visible = false;
	}

	private resize() {
		const w = Math.max(1, this.host.clientWidth),
			h = Math.max(1, this.host.clientHeight);
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
		this.render();
	}

	render() {
		if (this.disposed || this.frame) return;
		this.frame = requestAnimationFrame(() => {
			this.frame = 0;
			if (!this.disposed) this.renderer.render(this.scene, this.camera);
		});
	}

	dispose() {
		this.disposed = true;
		cancelAnimationFrame(this.frame);
		this.observer.disconnect();
		this.clear();
		this.grid.clear();
		this.controls.dispose();
		this.lineMaterial.dispose();
		this.solidMaterial.dispose();
		this.renderer.dispose();
		this.renderer.domElement.remove();
	}
}
