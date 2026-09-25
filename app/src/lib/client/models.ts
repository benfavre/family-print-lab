// Model API calls that do not fit LabStore.call: binary files, previews and AI suggestions (which
// return data rather than a new workspace), with abort support for superseded requests.
import { resolve } from '$app/paths';
import type { ModelDetail, ParamValues, PreviewResult } from '$lib/shared/cad';
import type { AiProviderId } from '$lib/shared/integrations';
import type { TaskInfo } from '$lib/shared/tasks';
import { parseStl } from './stl';

export const modelHref = (projectId: string, modelId: string) =>
	resolve('/projects/[id]/models/[modelId]', { id: projectId, modelId });
export const fileUrl = (
	modelId: string,
	versionId: string,
	file: 'model.stl' | 'model.3mf' | 'thumbnail.png' | 'thumbnail.webp'
) => `/api/models/${modelId}/versions/${versionId}/${file}`;

export class RequestError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly data: Record<string, unknown> = {}
	) {
		super(message);
	}
}

async function send<T>(
	method: string,
	path: string,
	body?: unknown,
	signal?: AbortSignal
): Promise<T> {
	let response: Response;
	try {
		response = await fetch(path, {
			method,
			signal,
			headers: body === undefined ? undefined : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
	} catch (error) {
		if ((error as Error).name === 'AbortError') throw error;
		throw new RequestError('Could not reach the app server. Is it still running?', 0);
	}
	const data = await response.json().catch(() => ({}));
	if (!response.ok)
		throw new RequestError(
			data.error ?? `Request failed (${response.status}).`,
			response.status,
			data
		);
	return data as T;
}

export const getDetail = (id: string, signal?: AbortSignal) =>
	send<ModelDetail>('GET', `/api/models/${id}`, undefined, signal);
export const preview = (source: string, params: ParamValues, signal?: AbortSignal) =>
	send<PreviewResult>('POST', '/api/models/preview', { source, params }, signal);
export const design = (
	input: { projectId: string; prompt: string; image?: unknown; provider?: AiProviderId },
	signal?: AbortSignal
) => send<{ task: TaskInfo }>('POST', '/api/models/design', input, signal);
export const aiEdit = (
	id: string,
	input: {
		source: string;
		instruction: string;
		params: ParamValues;
		image?: unknown;
		provider?: AiProviderId;
	},
	signal?: AbortSignal
) => send<{ task: TaskInfo }>('POST', `/api/models/${id}/ai-edit`, input, signal);

export async function loadMesh(
	modelId: string,
	versionId: string,
	signal?: AbortSignal
): Promise<Float32Array> {
	const response = await fetch(fileUrl(modelId, versionId, 'model.stl'), { signal });
	if (!response.ok) throw new RequestError('Could not load the model file.', response.status);
	return parseStl(await response.arrayBuffer());
}

export function decodeStl(base64: string): Float32Array {
	const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
	return parseStl(bytes.buffer);
}

export async function uploadThumbnail(
	modelId: string,
	versionId: string,
	pics: { png: Blob; webp: Blob | null }
) {
	await fetch(fileUrl(modelId, versionId, 'thumbnail.png'), {
		method: 'PUT',
		headers: { 'content-type': 'image/png' },
		body: pics.png
	}).catch(() => {});
	if (pics.webp)
		await fetch(fileUrl(modelId, versionId, 'thumbnail.webp'), {
			method: 'PUT',
			headers: { 'content-type': 'image/webp' },
			body: pics.webp
		}).catch(() => {});
}

/** Whether a version still has only the large PNG thumbnail (made before WebP ones existed). */
export async function lacksSmallThumbnail(modelId: string, versionId: string) {
	const r = await fetch(fileUrl(modelId, versionId, 'thumbnail.webp'), { method: 'HEAD' }).catch(
		() => null
	);
	return r?.ok === true && r.headers.get('content-type') === 'image/png';
}

/** Reads an image file for the AI (as the assistant does): JPEG/PNG/WebP/GIF under 5 MB. */
export function readImage(file: File): Promise<{ mediaType: string; data: string; url: string }> {
	return new Promise((ok, fail) => {
		if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type) || file.size > 5_000_000)
			return fail(new Error('Use a JPEG, PNG, WebP or GIF image under 5 MB.'));
		const reader = new FileReader();
		reader.onload = () => {
			const url = String(reader.result);
			ok({ mediaType: file.type, data: url.slice(url.indexOf(',') + 1), url });
		};
		reader.onerror = () => fail(new Error('Could not read the image.'));
		reader.readAsDataURL(file);
	});
}

export const MESH_ACCEPT = '.stl,.3mf,.obj';
export function meshFormat(name: string) {
	const ext = name.toLowerCase().split('.').pop() ?? '';
	return ['stl', '3mf', 'obj'].includes(ext) ? ext : null;
}

/**
 * Renders and stores a thumbnail for a version that has none (e.g. made by the AI or imported and not
 * opened yet), using an off-screen viewer. Resolves false when WebGL is unavailable.
 */
export async function makeThumbnail(modelId: string, versionId: string): Promise<boolean> {
	const { ModelViewer } = await import('./viewer');
	const host = document.createElement('div');
	host.style.cssText =
		'position:fixed;left:-10000px;top:0;width:480px;height:360px;pointer-events:none';
	document.body.appendChild(host);
	let viewer: InstanceType<typeof ModelViewer> | null = null;
	try {
		viewer = new ModelViewer(host);
		viewer.load(await loadMesh(modelId, versionId));
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
		const pics = await viewer.thumbnail();
		if (!pics) return false;
		await uploadThumbnail(modelId, versionId, pics);
		return true;
	} catch {
		return false;
	} finally {
		viewer?.dispose();
		host.remove();
	}
}
