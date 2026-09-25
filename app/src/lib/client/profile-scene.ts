import * as THREE from 'three';

/** A decorative, local-only scene. No workspace models or printer connection are needed. */
export function createProfileScene(host: HTMLElement) {
	const scene = new THREE.Scene();
	const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 80);
	camera.position.set(0, 2.2, 19);
	camera.lookAt(0, 0, 0);
	const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
	renderer.setClearColor(0x000000, 0);
	renderer.localClippingEnabled = true;
	renderer.outputColorSpace = THREE.SRGBColorSpace;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.2;
	renderer.domElement.setAttribute('aria-hidden', 'true');
	host.appendChild(renderer.domElement);

	const geometries: THREE.BufferGeometry[] = [];
	const materials: THREE.Material[] = [];
	function geometry<T extends THREE.BufferGeometry>(value: T): T {
		geometries.push(value);
		return value;
	}
	function material<T extends THREE.Material>(value: T): T {
		materials.push(value);
		return value;
	}
	function mesh(g: THREE.BufferGeometry, m: THREE.Material) {
		return new THREE.Mesh(geometry(g), material(m));
	}
	const light = (color: number, intensity: number, x: number, y: number, z: number) => {
		const source = new THREE.DirectionalLight(color, intensity);
		source.position.set(x, y, z);
		scene.add(source);
	};
	scene.add(new THREE.AmbientLight(0x9aaed5, 1.1));
	light(0x80e7ff, 4.5, -5, 4, 5);
	light(0xb197ff, 4, 5, 5, 3);
	light(0x689cff, 3, 0, -3, -4);

	// A continuous filament-like knot, with fine ribs following its curved surface.
	const sculpture = new THREE.Group();
	const knotGeometry = geometry(new THREE.TorusKnotGeometry(1.55, 0.48, 192, 20, 2, 3));
	sculpture.add(
		new THREE.Mesh(
			knotGeometry,
			material(
				new THREE.MeshStandardMaterial({ color: 0x397d8d, metalness: 0.48, roughness: 0.36 })
			)
		)
	);
	const ribs: number[] = [];
	const vertices = knotGeometry.getAttribute('position');
	for (let ring = 0; ring < 192; ring += 2) {
		for (let side = 0; side < 20; side++) {
			for (const i of [ring * 21 + side, ring * 21 + side + 1])
				ribs.push(vertices.getX(i) * 1.004, vertices.getY(i) * 1.004, vertices.getZ(i) * 1.004);
		}
	}
	const ribGeometry = geometry(new THREE.BufferGeometry());
	ribGeometry.setAttribute('position', new THREE.Float32BufferAttribute(ribs, 3));
	sculpture.add(
		new THREE.LineSegments(
			ribGeometry,
			material(new THREE.LineBasicMaterial({ color: 0x93dce3, transparent: true, opacity: 0.24 }))
		)
	);
	scene.add(sculpture);

	// A fluted vessel on a wireframe print bed, progressively revealed below the nozzle.
	const printer = new THREE.Group();
	const height = 4.5;
	const radiusAt = (y: number) => 0.93 + 0.22 * Math.cos(y * 1.35) + 0.12 * Math.sin(y * 2.3);
	const surface = (y: number, angle: number) =>
		radiusAt(y) * (1 + 0.09 * Math.cos(angle * 12 + y * 0.4));
	const positions: number[] = [];
	const indices: number[] = [];
	const layers = 150;
	const sides = 96;
	for (let row = 0; row <= layers; row++) {
		const y = (row / layers) * height;
		for (let side = 0; side <= sides; side++) {
			const angle = (side / sides) * Math.PI * 2;
			const radius = surface(y, angle);
			positions.push(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
			if (row < layers && side < sides) {
				const i = row * (sides + 1) + side;
				indices.push(i, i + sides + 1, i + 1, i + 1, i + sides + 1, i + sides + 2);
			}
		}
	}
	const vesselGeometry = geometry(new THREE.BufferGeometry());
	vesselGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
	vesselGeometry.setIndex(indices);
	vesselGeometry.computeVertexNormals();
	const cut = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
	printer.add(
		new THREE.Mesh(
			vesselGeometry,
			material(
				new THREE.MeshStandardMaterial({
					color: 0x8072be,
					metalness: 0.3,
					roughness: 0.42,
					side: THREE.DoubleSide,
					clippingPlanes: [cut]
				})
			)
		)
	);
	const layerLines: number[] = [];
	for (let row = 1; row <= layers; row++) {
		for (let side = 0; side < sides; side++) {
			for (const at of [side, side + 1]) {
				const angle = (at / sides) * Math.PI * 2;
				const y = (row / layers) * height;
				const radius = surface(y, angle) * 1.003;
				layerLines.push(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
			}
		}
	}
	const layerGeometry = geometry(new THREE.BufferGeometry());
	layerGeometry.setAttribute('position', new THREE.Float32BufferAttribute(layerLines, 3));
	printer.add(
		new THREE.LineSegments(
			layerGeometry,
			material(
				new THREE.LineBasicMaterial({
					color: 0xc0b3f1,
					opacity: 0.3,
					transparent: true,
					clippingPlanes: [cut]
				})
			)
		)
	);

	const bed = new THREE.GridHelper(5.8, 16, 0x7775b2, 0x494c75);
	geometry(bed.geometry);
	const bedMaterial = material(bed.material as THREE.Material);
	bedMaterial.transparent = true;
	bedMaterial.opacity = 0.32;
	bed.position.y = -0.06;
	printer.add(bed);
	const plate = mesh(
		new THREE.BoxGeometry(5.8, 0.08, 5.8),
		new THREE.MeshStandardMaterial({
			color: 0x151b31,
			metalness: 0.5,
			roughness: 0.6,
			transparent: true,
			opacity: 0.5
		})
	);
	plate.position.y = -0.12;
	printer.add(plate);

	const tracePositions = new Float32Array((sides + 1) * 3);
	const traceGeometry = geometry(new THREE.BufferGeometry());
	traceGeometry.setAttribute('position', new THREE.BufferAttribute(tracePositions, 3));
	const trace = new THREE.Line(
		traceGeometry,
		material(new THREE.LineBasicMaterial({ color: 0xd6baff }))
	);
	// The trace buffer changes every frame; its initial zero bounds must not cull it.
	trace.frustumCulled = false;
	printer.add(trace);
	const nozzle = mesh(
		new THREE.ConeGeometry(0.13, 0.35, 12),
		new THREE.MeshStandardMaterial({
			color: 0xb0a3d9,
			metalness: 0.7,
			roughness: 0.3,
			emissive: 0x533581,
			emissiveIntensity: 0.4
		})
	);
	nozzle.rotation.z = Math.PI;
	printer.add(nozzle);
	scene.add(printer);

	const satellite = mesh(
		new THREE.IcosahedronGeometry(0.65, 0),
		new THREE.MeshStandardMaterial({
			color: 0x6f72a5,
			metalness: 0.5,
			roughness: 0.45,
			flatShading: true
		})
	);
	scene.add(satellite);
	const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
	let paused = false;
	let disposed = false;
	let frame = 0;
	let elapsed = 0;
	let previous = 0;
	let edge = 6;

	function draw() {
		sculpture.position.set(-edge, 1.6 + Math.sin(elapsed * 0.23) * 0.22, -1);
		sculpture.rotation.set(0.3 + elapsed * 0.035, elapsed * 0.065, -0.3);
		printer.position.set(edge, -3.1, -0.5);
		printer.rotation.y = -0.45 + Math.sin(elapsed * 0.08) * 0.18;
		const progress = (elapsed * 0.024 + 0.56) % 1;
		const level = Math.min(1, progress / 0.86) * height;
		cut.constant = printer.position.y + level;
		for (let side = 0; side <= sides; side++) {
			const angle = (side / sides) * Math.PI * 2;
			const radius = surface(level, angle) * 1.008;
			tracePositions.set(
				[Math.cos(angle) * radius, level + 0.012, Math.sin(angle) * radius],
				side * 3
			);
		}
		traceGeometry.getAttribute('position').needsUpdate = true;
		const angle = elapsed * 1.6;
		const radius = surface(level, angle);
		nozzle.position.set(Math.cos(angle) * radius, level + 0.19, Math.sin(angle) * radius);
		nozzle.visible = trace.visible = progress < 0.86;
		satellite.position.set(-edge * 0.78, -3.9 + Math.sin(elapsed * 0.3) * 0.18, -2);
		satellite.rotation.set(elapsed * 0.07, elapsed * 0.1, 0.4);
		renderer.render(scene, camera);
	}
	function animate(now: number) {
		if (disposed) return;
		if (now - previous >= 1000 / 30) {
			elapsed += previous ? Math.min((now - previous) / 1000, 0.1) : 0;
			previous = now;
			draw();
		}
		frame = requestAnimationFrame(animate);
	}
	function updateMotion() {
		cancelAnimationFrame(frame);
		previous = 0;
		if (disposed) return;
		draw();
		if (!paused && !reducedMotion.matches && !document.hidden)
			frame = requestAnimationFrame(animate);
	}
	function resize() {
		const { width, height } = host.getBoundingClientRect();
		if (!width || !height) return;
		camera.aspect = width / height;
		camera.updateProjectionMatrix();
		renderer.setSize(width, height);
		edge = Math.max(3.2, camera.aspect * 5.3);
		draw();
	}
	const observer = new ResizeObserver(resize);
	observer.observe(host);
	reducedMotion.addEventListener('change', updateMotion);
	document.addEventListener('visibilitychange', updateMotion);
	resize();
	updateMotion();
	return {
		setPaused(value: boolean) {
			paused = value;
			updateMotion();
		},
		dispose() {
			disposed = true;
			cancelAnimationFrame(frame);
			observer.disconnect();
			reducedMotion.removeEventListener('change', updateMotion);
			document.removeEventListener('visibilitychange', updateMotion);
			geometries.forEach((g) => g.dispose());
			materials.forEach((m) => m.dispose());
			renderer.dispose();
			renderer.forceContextLoss();
			renderer.domElement.remove();
		}
	};
}
