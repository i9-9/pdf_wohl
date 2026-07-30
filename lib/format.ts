/** Number formatting shared by the UI. Locale is fixed so SSR and client agree. */

const KIB = 1024;
const MIB = 1024 * 1024;

export function formatBytes(bytes: number): string {
	if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MB`;
	if (bytes >= KIB) return `${(bytes / KIB).toFixed(0)} KB`;
	return `${bytes} B`;
}

export function formatPercent(fraction: number): string {
	return `${(fraction * 100).toFixed(1)}%`;
}

export function savedFraction(originalBytes: number, resultBytes: number): number {
	if (originalBytes <= 0) return 0;
	return Math.max(0, 1 - resultBytes / originalBytes);
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms} ms`;
	return `${(ms / 1000).toFixed(1)} s`;
}

export function outputName(name: string, targetPpi: number): string {
	const dot = name.toLowerCase().lastIndexOf(".pdf");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	return `${stem}-${targetPpi}ppi.pdf`;
}
