// Shrinks a photo in the browser before it goes to the family gallery (at most 400 KB, WebP where the
// browser can encode it, else JPEG), so the server needs no image library.
export const MAX_PHOTO_BYTES = 400 * 1024;

const bytesOf = (dataUrl: string) =>
	Math.floor(((dataUrl.length - dataUrl.indexOf(',') - 1) * 3) / 4);

export async function shrinkPhoto(file: Blob): Promise<string> {
	const bitmap = await createImageBitmap(file);
	try {
		let scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
		const canvas = document.createElement('canvas');
		for (let attempt = 0; attempt < 8; attempt++) {
			canvas.width = Math.max(1, Math.round(bitmap.width * scale));
			canvas.height = Math.max(1, Math.round(bitmap.height * scale));
			canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
			for (const quality of [0.85, 0.7, 0.55]) {
				let url = canvas.toDataURL('image/webp', quality);
				// Browsers that cannot encode WebP hand back a PNG.
				if (!url.startsWith('data:image/webp')) url = canvas.toDataURL('image/jpeg', quality);
				if (bytesOf(url) <= MAX_PHOTO_BYTES) return url;
			}
			scale *= 0.75;
		}
		throw new Error('That photo could not be made small enough.');
	} finally {
		bitmap.close();
	}
}
