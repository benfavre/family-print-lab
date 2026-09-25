// Dependency-free WebGL print visualizer: a part grows layer by layer on a build plate.
// setShape(category) previews a category; focus(category, progress) locks the stage to one project
// (progress 0..1 freezes the print height, null keeps it animating); release() resumes the tour.
/* eslint-disable */
export interface SceneHud {
	shape?: string;
	layer?: string;
	lost?: boolean;
}
export interface Scene {
	setShape(category: string): void;
	focus(category: string, progress?: number | null): void;
	release(): void;
	refreshTheme(): void;
	/** Stops drawing while something else covers the scene (e.g. a real model on top). */
	setPaused(paused: boolean): void;
	destroy(): void;
}

export function createScene(
	canvas: HTMLCanvasElement,
	onHud: (hud: SceneHud) => void
): Scene | null {
	const context = canvas.getContext('webgl', {
		antialias: true,
		alpha: true,
		premultipliedAlpha: false
	});
	if (!context) return null;
	const gl: WebGLRenderingContext = context;
	const reduced = matchMedia('(prefers-reduced-motion: reduce)');
	const TAU = Math.PI * 2,
		S = 180,
		L = 110,
		LAYER = 0.012;

	// --- Shapes: radius(theta, h in 0..1) and height. One per project category. ---
	const poly = (t: number, n: number) => {
		const k = TAU / n;
		const a = (((t % k) + k) % k) - k / 2;
		return Math.cos(Math.PI / n) / Math.cos(a);
	};
	const shapes: Record<
		string,
		{ name: string; H: number; color: number[]; r: (t: number, h: number) => number }
	> = {
		Home: {
			name: 'Twisted vase',
			H: 1.55,
			color: [0.62, 0.52, 1.0],
			r: (t, h) =>
				(0.42 + 0.2 * Math.sin(h * Math.PI * 1.15 + 0.2)) * (0.8 * poly(t + h * 1.6, 6) + 0.2)
		},
		Office: {
			name: 'Desk organizer',
			H: 1.15,
			color: [0.35, 0.82, 1.0],
			r: (t, h) =>
				0.62 *
				(1 + 0.1 * h) *
				Math.pow(Math.pow(Math.abs(Math.cos(t)), 4) + Math.pow(Math.abs(Math.sin(t)), 4), -0.25)
		},
		'Home lab': {
			name: 'Cable spool gear',
			H: 0.62,
			color: [0.66, 0.96, 0.34],
			r: (t, h) =>
				0.74 +
				0.11 * Math.max(-1, Math.min(1, Math.sin(t * 16) * 3)) -
				(h > 0.2 && h < 0.8 ? 0.16 : 0)
		},
		Creative: {
			name: 'Star lantern',
			H: 1.25,
			color: [1.0, 0.48, 0.72],
			r: (t, h) =>
				(0.4 + 0.26 * Math.pow(0.5 + 0.5 * Math.cos(5 * (t + h * 0.9)), 1.6)) *
				(0.85 + 0.25 * Math.sin(h * Math.PI))
		}
	};
	const order = ['Home', 'Office', 'Home lab', 'Creative'];

	// --- GL helpers ---
	function program(vs: string, fs: string) {
		const p = gl.createProgram()!;
		for (const [type, src] of [
			[gl.VERTEX_SHADER, vs],
			[gl.FRAGMENT_SHADER, fs]
		] as [number, string][]) {
			const s = gl.createShader(type)!;
			gl.shaderSource(s, src);
			gl.compileShader(s);
			if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
				throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
			gl.attachShader(p, s);
		}
		gl.linkProgram(p);
		if (!gl.getProgramParameter(p, gl.LINK_STATUS))
			throw new Error(gl.getProgramInfoLog(p) ?? 'program');
		const u: Record<string, WebGLUniformLocation | null> = {},
			n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
		for (let i = 0; i < n; i++) {
			const name = gl.getActiveUniform(p, i)!.name;
			u[name] = gl.getUniformLocation(p, name);
		}
		return { p, u, a: (name: string) => gl.getAttribLocation(p, name) };
	}
	const buffer = (
		data: BufferSource,
		target: number = gl.ARRAY_BUFFER,
		usage: number = gl.STATIC_DRAW
	) => {
		const b = gl.createBuffer()!;
		gl.bindBuffer(target, b);
		gl.bufferData(target, data, usage);
		return b;
	};
	type Prog = ReturnType<typeof program>;
	function attrib(prog: Prog, name: string, buf: WebGLBuffer, size: number) {
		const loc = prog.a(name);
		if (loc < 0) return;
		gl.bindBuffer(gl.ARRAY_BUFFER, buf);
		gl.enableVertexAttribArray(loc);
		gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
	}

	// --- Matrices (column-major) ---
	const perspective = (fov: number, aspect: number, near: number, far: number) => {
		const f = 1 / Math.tan(fov / 2),
			nf = 1 / (near - far);
		return [
			f / aspect,
			0,
			0,
			0,
			0,
			f,
			0,
			0,
			0,
			0,
			(far + near) * nf,
			-1,
			0,
			0,
			2 * far * near * nf,
			0
		];
	};
	function lookAt(e: number[], c: number[]) {
		let zx = e[0] - c[0],
			zy = e[1] - c[1],
			zz = e[2] - c[2],
			l = Math.hypot(zx, zy, zz);
		zx /= l;
		zy /= l;
		zz /= l;
		let xx = zz,
			xy = 0,
			xz = -zx;
		l = Math.hypot(xx, xz);
		xx /= l;
		xz /= l;
		const yx = zy * xz - zz * xy,
			yy = zz * xx - zx * xz,
			yz = zx * xy - zy * xx;
		return [
			xx,
			yx,
			zx,
			0,
			xy,
			yy,
			zy,
			0,
			xz,
			yz,
			zz,
			0,
			-(xx * e[0] + xy * e[1] + xz * e[2]),
			-(yx * e[0] + yy * e[1] + yz * e[2]),
			-(zx * e[0] + zy * e[1] + zz * e[2]),
			1
		];
	}
	function multiply(a: number[], b: number[]) {
		const o: number[] = new Array(16);
		for (let c = 0; c < 4; c++)
			for (let r = 0; r < 4; r++) {
				let s = 0;
				for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
				o[c * 4 + r] = s;
			}
		return o;
	}

	// --- Programs ---
	const solid = program(
		`
    attribute vec3 aPos; attribute vec3 aNormal; uniform mat4 uMVP; varying vec3 vPos; varying vec3 vNormal;
    void main(){ vPos = aPos; vNormal = aNormal; gl_Position = uMVP * vec4(aPos, 1.0); }`,
		`
    precision highp float; varying vec3 vPos; varying vec3 vNormal;
    uniform float uCut; uniform float uLayer; uniform vec3 uColor; uniform vec3 uCam; uniform float uFade; uniform vec3 uRim; uniform vec3 uHot;
    void main(){
      if (vPos.y > uCut) discard;
      vec3 n = normalize(vNormal); if (!gl_FrontFacing) n = -n;
      vec3 v = normalize(uCam - vPos);
      vec3 l = normalize(vec3(0.5, 1.0, 0.7));
      float diff = max(dot(n, l), 0.0) * 0.65 + 0.22;
      float spec = pow(max(dot(n, normalize(l + v)), 0.0), 40.0) * 0.5;
      float fres = pow(1.0 - max(dot(n, v), 0.0), 2.2);
      float ridge = abs(fract(vPos.y / uLayer) - 0.5) * 2.0;
      vec3 col = uColor * diff * (0.78 + 0.22 * smoothstep(0.0, 0.5, ridge)) + spec + uRim * fres * 0.55;
      float hot = smoothstep(uCut - 0.05, uCut, vPos.y);
      col = mix(col, uHot, hot * 0.85);
      if (!gl_FrontFacing) col = uColor * 0.16 + uHot * hot * 0.7;
      gl_FragColor = vec4(col * uFade, uFade);
    }`
	);
	const line = program(
		`
    attribute vec3 aPos; uniform mat4 uMVP; varying float vDist;
    void main(){ vDist = length(aPos.xz); gl_Position = uMVP * vec4(aPos, 1.0); }`,
		`
    precision mediump float; varying float vDist; uniform vec4 uColor; uniform float uFalloff;
    void main(){ gl_FragColor = vec4(uColor.rgb, uColor.a * (1.0 - smoothstep(uFalloff * 0.55, uFalloff, vDist))); }`
	);
	const points = program(
		`
    attribute vec3 aPos; uniform mat4 uMVP; uniform float uSize; uniform float uTime; varying float vA;
    void main(){ vec3 p = aPos; p.y = mod(p.y + uTime * 0.05, 3.0); vA = sin(p.y / 3.0 * 3.14159);
      gl_Position = uMVP * vec4(p, 1.0); gl_PointSize = uSize / gl_Position.w; }`,
		`
    precision mediump float; uniform vec4 uColor; varying float vA;
    void main(){ float d = length(gl_PointCoord - 0.5); gl_FragColor = vec4(uColor.rgb, uColor.a * vA * smoothstep(0.5, 0.0, d)); }`
	);

	// --- Static geometry: build plate grid, plate frame, dust ---
	const grid: number[] = [];
	const G = 2.2,
		step = 0.2;
	for (let x = -G; x <= G + 1e-6; x += step) grid.push(x, 0, -G, x, 0, G, -G, 0, x, G, 0, x);
	const gridBuf = buffer(new Float32Array(grid)),
		gridCount = grid.length / 3;
	const P = 1.25,
		frame = [-P, 0, -P, P, 0, -P, P, 0, -P, P, 0, P, P, 0, P, -P, 0, P, -P, 0, P, -P, 0, -P];
	for (let i = 1; i < 6; i++) {
		const k = -P + (i * P) / 3;
		frame.push(k, 0, -P - 0.06, k, 0, -P);
	}
	const frameBuf = buffer(new Float32Array(frame));
	const dust: number[] = [];
	for (let i = 0; i < 160; i++) {
		const a = Math.random() * TAU,
			r = 0.6 + Math.random() * 2.2;
		dust.push(Math.cos(a) * r, Math.random() * 3, Math.sin(a) * r);
	}
	const dustBuf = buffer(new Float32Array(dust));
	const contour = new Float32Array((S + 1) * 3),
		contourBuf = buffer(contour, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
	const head = new Float32Array(18),
		headBuf = buffer(head, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);

	// --- Part mesh ---
	let mesh: {
		key: string;
		shape: (typeof shapes)[string];
		pos: WebGLBuffer;
		nor: WebGLBuffer;
		idx: WebGLBuffer;
		count: number;
	} = null!;
	function build(key: string) {
		const shape = shapes[key] || shapes.Home,
			pos = new Float32Array((L + 1) * (S + 1) * 3),
			nor = new Float32Array(pos.length),
			idx = new Uint16Array(L * S * 6);
		for (let j = 0; j <= L; j++)
			for (let i = 0; i <= S; i++) {
				const t = (i / S) * TAU,
					h = j / L,
					r = shape.r(t, h),
					o = (j * (S + 1) + i) * 3;
				pos[o] = Math.cos(t) * r;
				pos[o + 1] = h * shape.H;
				pos[o + 2] = Math.sin(t) * r;
			}
		let k = 0;
		for (let j = 0; j < L; j++)
			for (let i = 0; i < S; i++) {
				const a = j * (S + 1) + i,
					b = a + 1,
					c = a + S + 1,
					d = c + 1;
				idx.set([a, c, b, b, c, d], k);
				k += 6;
				for (const [p, q, r] of [
					[a, c, b],
					[b, c, d]
				]) {
					const ux = pos[q * 3] - pos[p * 3],
						uy = pos[q * 3 + 1] - pos[p * 3 + 1],
						uz = pos[q * 3 + 2] - pos[p * 3 + 2],
						vx = pos[r * 3] - pos[p * 3],
						vy = pos[r * 3 + 1] - pos[p * 3 + 1],
						vz = pos[r * 3 + 2] - pos[p * 3 + 2];
					const nx = uy * vz - uz * vy,
						ny = uz * vx - ux * vz,
						nz = ux * vy - uy * vx;
					for (const v of [p, q, r]) {
						nor[v * 3] += nx;
						nor[v * 3 + 1] += ny;
						nor[v * 3 + 2] += nz;
					}
				}
			}
		if (mesh) {
			gl.deleteBuffer(mesh.pos);
			gl.deleteBuffer(mesh.nor);
			gl.deleteBuffer(mesh.idx);
		}
		mesh = {
			key,
			shape,
			pos: buffer(pos),
			nor: buffer(nor),
			idx: buffer(idx, gl.ELEMENT_ARRAY_BUFFER),
			count: idx.length
		};
		onHud({ shape: shape.name });
	}

	// --- Loop ---
	const PRINT = 11,
		HOLD = 2.6,
		FADE = 0.7;
	let current = 'Home',
		locked = false,
		fixed: number | null = null,
		cycleIndex = 0,
		started = performance.now(),
		pending: ReturnType<typeof setTimeout> | undefined,
		visible = true,
		paused = false,
		frameId = 0,
		lastHud = 0,
		destroyed = false;
	const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
	// Colors come from the page theme's --c1 (accent) and --c4 (hot) channels.
	const theme = { accent: [0.37, 0.9, 1], hot: [1, 0.7, 0.33], light: false };
	function readTheme() {
		const css = getComputedStyle(document.documentElement),
			rgb = (name: string, fallback: number[]) => {
				const v = css.getPropertyValue(name).trim().split(/\s+/).map(Number);
				return v.length === 3 && v.every(Number.isFinite) ? v.map((x) => x / 255) : fallback;
			};
		theme.accent = rgb('--c1', theme.accent);
		theme.hot = rgb('--c4', theme.hot);
		theme.light = css.colorScheme.includes('light');
	}
	readTheme();
	build(current);

	function resize() {
		const dpr = Math.min(devicePixelRatio || 1, 2),
			w = Math.max(1, Math.round(canvas.clientWidth * dpr)),
			h = Math.max(1, Math.round(canvas.clientHeight * dpr));
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}
	}

	function draw(now: number) {
		resize();
		const shape = mesh.shape,
			elapsed = reduced.matches ? PRINT * 0.72 : (now - started) / 1000;
		const progress = fixed ?? Math.min(elapsed / PRINT, 1),
			fade =
				fixed === null && elapsed > PRINT + HOLD
					? Math.max(0, 1 - (elapsed - PRINT - HOLD) / FADE)
					: 1;
		const eased = fixed === null ? 1 - Math.pow(1 - progress, 1.35) : progress,
			cut = progress >= 1 ? shape.H + 0.01 : Math.max(eased, 0.004) * shape.H;
		if (fixed === null && elapsed > PRINT + HOLD + FADE) {
			if (!locked) {
				cycleIndex = (order.indexOf(current) + 1) % order.length;
				current = order[cycleIndex];
				build(current);
			}
			started = now;
		}

		pointer.x += (pointer.tx - pointer.x) * 0.05;
		pointer.y += (pointer.ty - pointer.y) * 0.05;
		const t = reduced.matches ? 0.6 : now / 1000,
			yaw = t * 0.16 + pointer.x * 0.5,
			pitch = 0.42 + pointer.y * 0.18,
			dist = 4.9;
		const target = [0, shape.H * 0.42, 0],
			eye = [
				Math.cos(yaw) * Math.cos(pitch) * dist,
				target[1] + Math.sin(pitch) * dist,
				Math.sin(yaw) * Math.cos(pitch) * dist
			];
		const mvp = multiply(
			perspective(0.62, canvas.width / canvas.height, 0.1, 50),
			lookAt(eye, target)
		);

		gl.viewport(0, 0, canvas.width, canvas.height);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
		gl.enable(gl.DEPTH_TEST);
		gl.disable(gl.CULL_FACE);
		gl.enable(gl.BLEND);

		// Plate (additive glow on dark themes, plain alpha on light ones)
		const glow = theme.light ? gl.ONE_MINUS_SRC_ALPHA : gl.ONE,
			[ar, ag, ab] = theme.accent,
			[tr, tg, tb] = theme.hot;
		gl.blendFunc(gl.SRC_ALPHA, glow);
		gl.depthMask(false);
		gl.useProgram(line.p);
		gl.uniformMatrix4fv(line.u.uMVP, false, mvp);
		attrib(line, 'aPos', gridBuf, 3);
		gl.uniform4f(line.u.uColor, ar, ag, ab, theme.light ? 0.3 : 0.38);
		gl.uniform1f(line.u.uFalloff, G);
		gl.drawArrays(gl.LINES, 0, gridCount);
		attrib(line, 'aPos', frameBuf, 3);
		gl.uniform4f(line.u.uColor, ar, ag, ab, 0.8);
		gl.uniform1f(line.u.uFalloff, 9);
		gl.drawArrays(gl.LINES, 0, frame.length / 3);
		gl.depthMask(true);

		// Part
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		gl.useProgram(solid.p);
		gl.uniformMatrix4fv(solid.u.uMVP, false, mvp);
		gl.uniform1f(solid.u.uCut, cut);
		gl.uniform1f(solid.u.uLayer, LAYER * 2.2);
		gl.uniform3fv(solid.u.uColor, shape.color);
		gl.uniform3fv(solid.u.uCam, eye);
		gl.uniform1f(solid.u.uFade, fade);
		gl.uniform3fv(solid.u.uRim, theme.accent);
		gl.uniform3fv(solid.u.uHot, theme.hot);
		attrib(solid, 'aPos', mesh.pos, 3);
		attrib(solid, 'aNormal', mesh.nor, 3);
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.idx);
		gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
		gl.disableVertexAttribArray(solid.a('aNormal'));

		// Active layer contour + print head
		gl.blendFunc(gl.SRC_ALPHA, glow);
		gl.useProgram(line.p);
		gl.uniform1f(line.u.uFalloff, 9);
		if (progress < 1) {
			const h = cut / shape.H;
			for (let i = 0; i <= S; i++) {
				const a = (i / S) * TAU,
					r = shape.r(a, h) + 0.004;
				contour.set([Math.cos(a) * r, cut, Math.sin(a) * r], i * 3);
			}
			gl.bindBuffer(gl.ARRAY_BUFFER, contourBuf);
			gl.bufferSubData(gl.ARRAY_BUFFER, 0, contour);
			attrib(line, 'aPos', contourBuf, 3);
			gl.uniform4f(line.u.uColor, tr, tg, tb, 0.95);
			gl.drawArrays(gl.LINE_STRIP, 0, S + 1);
		}
		const parked = progress >= 1,
			a = t * 5.5,
			hr = parked ? 1.1 : shape.r(a, cut / shape.H);
		const nx = parked ? 1.1 : Math.cos(a) * hr,
			nz = parked ? -1.1 : Math.sin(a) * hr,
			ny = parked ? shape.H + 0.35 : cut + 0.02,
			top = ny + 0.22;
		head.set([
			-1.6,
			top,
			nz,
			1.6,
			top,
			nz,
			nx,
			top,
			nz,
			nx,
			ny + 0.06,
			nz,
			nx - 0.06,
			ny + 0.12,
			nz,
			nx,
			ny,
			nz
		]);
		gl.bindBuffer(gl.ARRAY_BUFFER, headBuf);
		gl.bufferSubData(gl.ARRAY_BUFFER, 0, head);
		attrib(line, 'aPos', headBuf, 3);
		gl.uniform4f(line.u.uColor, ar, ag, ab, 0.6 * fade);
		gl.drawArrays(gl.LINES, 0, 4);
		gl.drawArrays(gl.LINE_STRIP, 3, 3);

		// Nozzle glow + dust
		gl.depthMask(false);
		gl.useProgram(points.p);
		gl.uniformMatrix4fv(points.u.uMVP, false, mvp);
		gl.bindBuffer(gl.ARRAY_BUFFER, headBuf);
		gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array([nx, ny, nz]));
		attrib(points, 'aPos', headBuf, 3);
		gl.uniform1f(points.u.uTime, 0);
		gl.uniform1f(points.u.uSize, 90 * (canvas.width / 900));
		gl.uniform4f(points.u.uColor, tr, tg, tb, parked ? 0 : 1);
		gl.drawArrays(gl.POINTS, 0, 1);
		attrib(points, 'aPos', dustBuf, 3);
		gl.uniform1f(points.u.uTime, t);
		gl.uniform1f(points.u.uSize, 7 * (canvas.width / 900));
		gl.uniform4f(points.u.uColor, ar, ag, ab, theme.light ? 0.35 : 0.55);
		gl.drawArrays(gl.POINTS, 0, dust.length / 3);
		gl.depthMask(true);

		if (now - lastHud > 100) {
			lastHud = now;
			onHud({ layer: String(Math.round(cut / LAYER)).padStart(3, '0') });
		}
	}

	function loop(now: number) {
		frameId = 0;
		if (destroyed) return;
		draw(now);
		if (visible && !paused && !document.hidden && !reduced.matches)
			frameId = requestAnimationFrame(loop);
	}
	const kick = () => {
		if (!frameId && !destroyed && !paused) frameId = requestAnimationFrame(loop);
	};

	const resizeObserver = new ResizeObserver(kick);
	resizeObserver.observe(canvas);
	const visibility = new IntersectionObserver(([entry]) => {
		visible = entry.isIntersecting;
		if (visible) kick();
	});
	visibility.observe(canvas);
	document.addEventListener('visibilitychange', kick);
	reduced.addEventListener?.('change', kick);
	const onPointer = (e: PointerEvent) => {
		pointer.tx = (e.clientX / innerWidth) * 2 - 1;
		pointer.ty = (e.clientY / innerHeight) * 2 - 1;
	};
	addEventListener('pointermove', onPointer, { passive: true });
	canvas.addEventListener('webglcontextlost', (e) => {
		e.preventDefault();
		cancelAnimationFrame(frameId);
		onHud({ lost: true });
	});

	const api = {
		setPaused(on: boolean) {
			paused = on;
			if (on) {
				cancelAnimationFrame(frameId);
				frameId = 0;
			} else kick();
		},
		setShape(category: string) {
			clearTimeout(pending);
			pending = setTimeout(() => {
				if (locked || !shapes[category] || category === current) return;
				current = category;
				build(category);
				started = performance.now();
				kick();
			}, 160);
		},
		focus(category: string, progress: number | null = null) {
			clearTimeout(pending);
			const next = typeof progress === 'number' ? Math.min(Math.max(progress, 0), 1) : null;
			if (locked && category === current && next === fixed) return;
			locked = true;
			fixed = next;
			if (shapes[category] && category !== current) {
				current = category;
				build(category);
				started = performance.now();
			}
			kick();
		},
		refreshTheme() {
			readTheme();
			kick();
		},
		destroy() {
			destroyed = true;
			cancelAnimationFrame(frameId);
			clearTimeout(pending);
			resizeObserver.disconnect();
			visibility.disconnect();
			document.removeEventListener('visibilitychange', kick);
			reduced.removeEventListener?.('change', kick);
			removeEventListener('pointermove', onPointer);
			gl.getExtension('WEBGL_lose_context')?.loseContext();
		},
		release() {
			if (!locked) return;
			locked = false;
			fixed = null;
			started = performance.now();
			kick();
		}
	};
	kick();
	return api;
}
