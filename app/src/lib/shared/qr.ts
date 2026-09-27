// A small QR code encoder (ISO/IEC 18004): byte mode, error correction level M, versions 1–10 (up
// to 213 bytes), enough for the phone key link. Follows the structure of Project Nayuki's reference
// implementation (https://www.nayuki.io/page/qr-code-generator-library, MIT); the tests compare its
// output with python-qrcode for every mask.

/** Error correction codewords per block and number of blocks at level M, by version (index 0 unused). */
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const MAX_VERSION = 10;
/** Level M's two format bits. */
const FORMAT_M = 0;

export type QrMatrix = boolean[][];

function rawDataModules(ver: number) {
	let result = (16 * ver + 128) * ver + 64;
	if (ver >= 2) {
		const align = Math.floor(ver / 7) + 2;
		result -= (25 * align - 10) * align - 55;
		if (ver >= 7) result -= 36;
	}
	return result;
}
const dataCodewords = (ver: number) =>
	Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ver] * BLOCKS[ver];

// ---------- Reed–Solomon over GF(256), polynomial 0x11D ----------

function multiply(x: number, y: number) {
	let z = 0;
	for (let i = 7; i >= 0; i--) {
		z = (z << 1) ^ ((z >>> 7) * 0x11d);
		z ^= ((y >>> i) & 1) * x;
	}
	return z & 0xff;
}

function divisor(degree: number) {
	const result = new Array<number>(degree).fill(0);
	result[degree - 1] = 1;
	let root = 1;
	for (let i = 0; i < degree; i++) {
		for (let j = 0; j < result.length; j++) {
			result[j] = multiply(result[j], root);
			if (j + 1 < result.length) result[j] ^= result[j + 1];
		}
		root = multiply(root, 0x02);
	}
	return result;
}

function remainder(data: number[], div: number[]) {
	const result = div.map(() => 0);
	for (const b of data) {
		const factor = b ^ (result.shift() as number);
		result.push(0);
		div.forEach((coef, i) => (result[i] ^= multiply(coef, factor)));
	}
	return result;
}

// ---------- Codewords ----------

function codewords(bytes: Uint8Array, ver: number) {
	const bits: number[] = [];
	const put = (value: number, length: number) => {
		for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
	};
	put(0b0100, 4);
	put(bytes.length, ver < 10 ? 8 : 16);
	for (const b of bytes) put(b, 8);
	const capacity = dataCodewords(ver) * 8;
	put(0, Math.min(4, capacity - bits.length));
	put(0, (8 - (bits.length % 8)) % 8);
	for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
	const data: number[] = [];
	for (let i = 0; i < bits.length; i += 8)
		data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

	// Split into blocks, add each block's error correction, then interleave.
	const blocks = BLOCKS[ver];
	const eccLength = ECC_PER_BLOCK[ver];
	const raw = Math.floor(rawDataModules(ver) / 8);
	const shortBlocks = blocks - (raw % blocks);
	const shortLength = Math.floor(raw / blocks);
	const div = divisor(eccLength);
	const parts: number[][] = [];
	for (let i = 0, k = 0; i < blocks; i++) {
		const dat = data.slice(k, k + shortLength - eccLength + (i < shortBlocks ? 0 : 1));
		k += dat.length;
		const ecc = remainder(dat, div);
		if (i < shortBlocks) dat.push(0);
		parts.push([...dat, ...ecc]);
	}
	const result: number[] = [];
	for (let i = 0; i < parts[0].length; i++)
		parts.forEach((block, j) => {
			// Skip the padding byte of short blocks.
			if (i !== shortLength - eccLength || j >= shortBlocks) result.push(block[i]);
		});
	return result;
}

// ---------- Matrix ----------

class Grid {
	size: number;
	modules: QrMatrix;
	fixed: QrMatrix;
	constructor(readonly ver: number) {
		this.size = ver * 4 + 17;
		this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
		this.fixed = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
	}
	set(x: number, y: number, dark: boolean) {
		this.modules[y][x] = dark;
		this.fixed[y][x] = true;
	}

	functionPatterns() {
		for (let i = 0; i < this.size; i++) {
			this.set(6, i, i % 2 === 0);
			this.set(i, 6, i % 2 === 0);
		}
		this.finder(3, 3);
		this.finder(this.size - 4, 3);
		this.finder(3, this.size - 4);
		const positions = this.alignmentPositions();
		const last = positions.length - 1;
		positions.forEach((x, i) =>
			positions.forEach((y, j) => {
				if (!((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)))
					this.alignment(x, y);
			})
		);
		this.format(0);
		this.version();
	}

	alignmentPositions() {
		if (this.ver === 1) return [];
		const count = Math.floor(this.ver / 7) + 2;
		const step = Math.ceil((this.ver * 4 + 4) / (count * 2 - 2)) * 2;
		const result = [6];
		for (let pos = this.size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
		return result;
	}

	finder(x: number, y: number) {
		for (let dy = -4; dy <= 4; dy++)
			for (let dx = -4; dx <= 4; dx++) {
				const dist = Math.max(Math.abs(dx), Math.abs(dy));
				const xx = x + dx,
					yy = y + dy;
				if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size)
					this.set(xx, yy, dist !== 2 && dist !== 4);
			}
	}

	alignment(x: number, y: number) {
		for (let dy = -2; dy <= 2; dy++)
			for (let dx = -2; dx <= 2; dx++)
				this.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
	}

	format(mask: number) {
		const data = (FORMAT_M << 3) | mask;
		let rem = data;
		for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
		const bits = ((data << 10) | rem) ^ 0x5412;
		const bit = (i: number) => ((bits >>> i) & 1) === 1;
		for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
		this.set(8, 7, bit(6));
		this.set(8, 8, bit(7));
		this.set(7, 8, bit(8));
		for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
		for (let i = 0; i < 8; i++) this.set(this.size - 1 - i, 8, bit(i));
		for (let i = 8; i < 15; i++) this.set(8, this.size - 15 + i, bit(i));
		this.set(8, this.size - 8, true);
	}

	version() {
		if (this.ver < 7) return;
		let rem = this.ver;
		for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
		const bits = (this.ver << 12) | rem;
		for (let i = 0; i < 18; i++) {
			const dark = ((bits >>> i) & 1) === 1;
			const a = this.size - 11 + (i % 3),
				b = Math.floor(i / 3);
			this.set(a, b, dark);
			this.set(b, a, dark);
		}
	}

	place(data: number[]) {
		let i = 0;
		for (let right = this.size - 1; right >= 1; right -= 2) {
			if (right === 6) right = 5;
			for (let vert = 0; vert < this.size; vert++)
				for (let j = 0; j < 2; j++) {
					const x = right - j;
					const upward = ((right + 1) & 2) === 0;
					const y = upward ? this.size - 1 - vert : vert;
					if (!this.fixed[y][x] && i < data.length * 8) {
						this.modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
						i++;
					}
				}
		}
	}

	mask(mask: number) {
		for (let y = 0; y < this.size; y++)
			for (let x = 0; x < this.size; x++) {
				if (this.fixed[y][x]) continue;
				const flip = [
					(x + y) % 2 === 0,
					y % 2 === 0,
					x % 3 === 0,
					(x + y) % 3 === 0,
					(Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
					((x * y) % 2) + ((x * y) % 3) === 0,
					(((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
					(((x + y) % 2) + ((x * y) % 3)) % 2 === 0
				][mask];
				if (flip) this.modules[y][x] = !this.modules[y][x];
			}
	}

	/** The standard's penalty score (lower is easier to scan). */
	penalty() {
		const n = this.size;
		const m = this.modules;
		const at = (x: number, y: number, horizontal: boolean) => (horizontal ? m[y][x] : m[x][y]);
		let score = 0;
		for (const horizontal of [true, false])
			for (let a = 0; a < n; a++) {
				let run = 1;
				for (let b = 1; b <= n; b++) {
					if (b < n && at(b, a, horizontal) === at(b - 1, a, horizontal)) run++;
					else {
						if (run >= 5) score += 3 + run - 5;
						run = 1;
					}
				}
				// Finder-like 1:1:3:1:1 with four light modules on one side (outside counts as light).
				const light = (b: number) => b < 0 || b >= n || !at(b, a, horizontal);
				for (let b = 0; b + 6 < n; b++) {
					const core = [1, 0, 1, 1, 1, 0, 1].every(
						(v, k) => at(b + k, a, horizontal) === (v === 1)
					);
					if (!core) continue;
					const before = [1, 2, 3, 4].every((k) => light(b - k));
					const after = [7, 8, 9, 10].every((k) => light(b + k));
					if (before || after) score += 40;
				}
			}
		for (let y = 0; y < n - 1; y++)
			for (let x = 0; x < n - 1; x++) {
				const c = m[y][x];
				if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
			}
		const dark = m.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
		const total = n * n;
		score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
		return score;
	}
}

/** The QR code for `text` (UTF-8), as rows of dark (true) and light modules, without the quiet zone. */
export function qrMatrix(text: string, o: { mask?: number } = {}): QrMatrix {
	const bytes = new TextEncoder().encode(text);
	let ver = 1;
	while (ver <= MAX_VERSION && dataCodewords(ver) * 8 < 4 + (ver < 10 ? 8 : 16) + bytes.length * 8)
		ver++;
	if (ver > MAX_VERSION) throw new Error('Too long for a QR code here.');
	const data = codewords(bytes, ver);
	const make = (mask: number) => {
		const grid = new Grid(ver);
		grid.functionPatterns();
		grid.place(data);
		grid.mask(mask);
		grid.format(mask);
		return grid;
	};
	if (o.mask !== undefined) return make(o.mask).modules;
	let best: Grid | null = null;
	let bestScore = Infinity;
	for (let mask = 0; mask < 8; mask++) {
		const grid = make(mask);
		const score = grid.penalty();
		if (score < bestScore) [best, bestScore] = [grid, score];
	}
	return best!.modules;
}

/** An SVG path of the dark modules, offset by a 4-module quiet zone; the view box is size + 8. */
export function qrPath(matrix: QrMatrix) {
	let d = '';
	matrix.forEach((row, y) =>
		row.forEach((dark, x) => {
			if (dark) d += `M${x + 4} ${y + 4}h1v1h-1z`;
		})
	);
	return { d, size: matrix.length + 8 };
}
