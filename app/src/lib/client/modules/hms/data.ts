// Reads for the hms components: a printer's alerts and history, and the errors of one job.
import type { HmsEventRow, HmsPrinterView, HmsSeverity } from '$lib/shared/hms';

async function get<T>(url: string): Promise<T | null> {
	try {
		const res = await fetch(url);
		return res.ok ? ((await res.json()) as T) : null;
	} catch {
		return null;
	}
}

export function printerAlerts(
	printerId: string,
	o: { severity?: HmsSeverity[]; limit?: number; offset?: number } = {}
) {
	const q = new URLSearchParams({ limit: String(o.limit ?? 50), offset: String(o.offset ?? 0) });
	if (o.severity?.length) q.set('severity', o.severity.join(','));
	return get<HmsPrinterView>(`/api/printers/${encodeURIComponent(printerId)}/hms?${q}`);
}

export async function jobErrors(jobId: string): Promise<HmsEventRow[]> {
	return (
		(await get<{ events: HmsEventRow[] }>(`/api/hms/jobs/${encodeURIComponent(jobId)}`))?.events ??
		[]
	);
}
