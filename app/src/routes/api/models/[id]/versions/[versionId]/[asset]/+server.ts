import type { RequestHandler } from '@sveltejs/kit';
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import { api } from '$lib/server/http';
import { AppError } from '$lib/server/validation';
import { readBinary } from '$lib/server/cad/requests';

/** Version files: model.stl, model.3mf (downloads) and thumbnail.png. */
export const GET: RequestHandler = api(({ params, url, request }, rt) => {
	const { id, versionId, asset } = params as { id: string; versionId: string; asset: string };
	if (asset === 'thumbnail.png') {
		rt.models.version(id, versionId);
		const file = rt.models.path(id, versionId, 'png');
		if (!fs.existsSync(file)) throw new AppError(404, 'No thumbnail yet.');
		return new Response(fs.readFileSync(file), {
			headers: {
				'content-type': 'image/png',
				'cache-control': 'private, max-age=31536000, immutable'
			}
		});
	}
	const format = asset === 'model.stl' ? 'stl' : asset === 'model.3mf' ? '3mf' : null;
	if (!format) throw new AppError(404, 'Unknown file.');
	// Meshes shown in the app (not downloads) go compressed: STL shrinks to about a third. Versions never
	// change, so each is compressed once and kept next to the original.
	const gzipOk = /\bgzip\b/.test(request.headers.get('accept-encoding') ?? '');
	if (format === 'stl' && gzipOk && !url.searchParams.has('download')) {
		rt.models.version(id, versionId);
		const gz = rt.models.path(id, versionId, 'stl.gz');
		if (!fs.existsSync(gz)) {
			const tmp = `${gz}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, gzipSync(fs.readFileSync(rt.models.path(id, versionId)), { level: 6 }));
			fs.renameSync(tmp, gz);
		}
		return new Response(new Uint8Array(fs.readFileSync(gz)), {
			headers: {
				'content-type': 'model/stl',
				'content-encoding': 'gzip',
				vary: 'accept-encoding',
				'cache-control': 'private, max-age=31536000, immutable'
			}
		});
	}
	const file = rt.models.file(id, versionId, format);
	const disposition = url.searchParams.has('download')
		? `attachment; filename="${file.name}"`
		: 'inline';
	return new Response(new Uint8Array(file.data), {
		headers: {
			'content-type': file.type,
			'content-disposition': disposition,
			'cache-control': 'private, max-age=31536000, immutable'
		}
	});
});

export const PUT: RequestHandler = api(async ({ params, request }, rt) => {
	if (params.asset !== 'thumbnail.png') throw new AppError(404, 'Unknown file.');
	rt.models.saveThumbnail(params.id!, params.versionId!, await readBinary(request, 2_000_000));
	return new Response(null, { status: 204 });
});
