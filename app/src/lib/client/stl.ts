// STL parsing without three.js, so pages that only fetch meshes do not load the 3D library.

/** Parses binary or ASCII STL into a non-indexed position array. */
export function parseStl(buffer: ArrayBuffer): Float32Array {
	const view = new DataView(buffer);
	if (buffer.byteLength >= 84) {
		const count = view.getUint32(80, true);
		if (84 + count * 50 === buffer.byteLength) {
			const out = new Float32Array(count * 9);
			for (let i = 0; i < count; i++)
				for (let k = 0; k < 9; k++)
					out[i * 9 + k] = view.getFloat32(84 + i * 50 + 12 + k * 4, true);
			return out;
		}
	}
	const text = new TextDecoder().decode(buffer);
	const nums: number[] = [];
	for (const m of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) nums.push(+m[1], +m[2], +m[3]);
	return new Float32Array(nums);
}
