"use client";

import { useState } from "react";
import { formatBytes, formatDuration, formatPercent, savedFraction } from "../lib/format";
import type { ObjectOutcome, QueueItem } from "../lib/types";

interface FileRowProps {
	item: QueueItem;
	onRemove: (id: string) => void;
	onCompare: (id: string) => void;
}

const PHASE_LABEL: Record<QueueItem["phase"], string> = {
	queued: "En cola",
	loading: "Abriendo",
	analyzing: "Analizando",
	recompressing: "Comprimiendo",
	saving: "Guardando",
	done: "Listo",
	error: "Error",
};

export default function FileRow({ item, onRemove, onCompare }: FileRowProps) {
	const [open, setOpen] = useState(false);
	const done = item.phase === "done";
	const failed = item.phase === "error";
	const running = !done && !failed && item.phase !== "queued";
	const saved = done ? savedFraction(item.originalBytes, item.resultBytes) : 0;
	const grew = done && item.stats?.returnedOriginal === true;
	const width = Math.round((failed ? 1 : Math.max(0, item.progress)) * 100);

	return (
		<li className="border-t border-[var(--color-rule)]">
			<div className="px-5 py-5 sm:px-6">
				<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
					<div className="min-w-0 flex-1">
						<p className="truncate text-[0.9375rem] text-[var(--color-ink)]" title={item.file.name}>
							{item.file.name}
						</p>
						<p className="mt-1.5 flex flex-wrap items-baseline gap-x-2 text-sm text-[var(--color-mute)]">
							<span className="num">{formatBytes(item.originalBytes)}</span>
							{done && (
								<>
									<span className="text-[var(--color-faint)]">→</span>
									<span className="num text-[var(--color-ink)]">
										{formatBytes(item.resultBytes)}
									</span>
									<span
										className={[
											"num",
											grew ? "text-[var(--color-faint)]" : "text-[var(--color-accent)]",
										].join(" ")}
									>
										{grew ? "0%" : `−${formatPercent(saved)}`}
									</span>
								</>
							)}
						</p>
					</div>

					<div className="flex shrink-0 flex-wrap items-center gap-2">
						{done && item.resultUrl && (
							<a href={item.resultUrl} download={item.resultName} className="btn-primary">
								Descargar
							</a>
						)}
						{done && (
							<button type="button" onClick={() => onCompare(item.id)} className="btn-ghost">
								Comparar
							</button>
						)}
						{item.stats && (
							<button
								type="button"
								onClick={() => setOpen((value) => !value)}
								aria-expanded={open}
								className="px-2 py-1.5 text-xs text-[var(--color-mute)] underline decoration-[var(--color-rule)] underline-offset-4 hover:text-[var(--color-ink)]"
							>
								{open ? "Menos" : "Detalle"}
							</button>
						)}
						<button
							type="button"
							onClick={() => onRemove(item.id)}
							className="px-2 py-1.5 text-xs text-[var(--color-faint)] hover:text-[var(--color-ink)]"
							aria-label={`Quitar ${item.file.name}`}
						>
							Quitar
						</button>
					</div>
				</div>

				<div
					className={[
						"progress mt-4",
						done && !grew ? "is-done" : "",
						failed ? "is-error" : "",
					].join(" ")}
					role="progressbar"
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={width}
				>
					<span style={{ width: `${width}%` }} />
				</div>

				<p className="mt-2 flex flex-wrap items-baseline gap-x-3 text-xs text-[var(--color-mute)]">
					<span>{PHASE_LABEL[item.phase]}</span>
					{item.detail && <span className="text-[var(--color-faint)]">{item.detail}</span>}
					{running && item.total > 0 && (
						<span className="num">
							{item.current}/{item.total}
						</span>
					)}
					{running && item.bytesSaved > 0 && (
						<span className="num">−{formatBytes(item.bytesSaved)}</span>
					)}
					{done && item.stats && (
						<span className="num text-[var(--color-faint)]">
							{item.stats.imagesRecompressed}/{item.stats.imagesTotal} ·{" "}
							{formatDuration(item.stats.elapsedMs)}
						</span>
					)}
				</p>

				{failed && item.error && (
					<p className="mt-2 text-xs text-[var(--color-accent)]">{item.error}</p>
				)}
				{grew && (
					<p className="mt-2 text-xs text-[var(--color-mute)]">
						Sin ganancia: se conserva el original.
					</p>
				)}
			</div>

			{open && item.stats && (
				<div className="border-t border-[var(--color-rule)] bg-[var(--color-paper)]/50 px-5 py-5 sm:px-6">
					<dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-xs sm:grid-cols-4">
						<Fact label="Páginas" value={String(item.stats.pageCount)} />
						<Fact label="XObjects" value={String(item.stats.imagesTotal)} />
						<Fact label="Recomprimidas" value={String(item.stats.imagesRecompressed)} />
						<Fact label="SMasks" value={String(item.stats.smasksDropped)} />
						<Fact label="Img. antes" value={formatBytes(item.stats.imageBytesBefore)} />
						<Fact label="Img. después" value={formatBytes(item.stats.imageBytesAfter)} />
						<Fact
							label="Resto"
							value={formatBytes(
								Math.max(0, item.stats.originalBytes - item.stats.imageBytesBefore),
							)}
						/>
						<Fact label="Tiempo" value={formatDuration(item.stats.elapsedMs)} />
					</dl>

					<table className="mt-6 w-full border-collapse text-xs">
						<thead>
							<tr className="border-b border-[var(--color-rule)] text-left">
								<th className="label py-2 pr-3 font-medium">xref</th>
								<th className="label py-2 pr-3 font-medium">px</th>
								<th className="label py-2 pr-3 font-medium">ppi</th>
								<th className="label py-2 pr-3 font-medium">out</th>
								<th className="label py-2 pr-3 font-medium">peso</th>
								<th className="label py-2 font-medium">estado</th>
							</tr>
						</thead>
						<tbody className="text-[var(--color-mute)]">
							{item.stats.objects.map((object) => (
								<tr key={object.xref} className="border-b border-[var(--color-rule)]/70">
									<td className="num py-2.5 pr-3 text-[var(--color-ink)]">{object.xref}</td>
									<td className="num py-2.5 pr-3">
										{object.pixelWidth}×{object.pixelHeight}
									</td>
									<td className="num py-2.5 pr-3">
										{object.effectivePpi > 0 ? object.effectivePpi.toFixed(0) : "—"}
									</td>
									<td className="num py-2.5 pr-3">
										{object.outcome === "recompressed"
											? `${object.newPixelWidth}×${object.newPixelHeight}`
											: "—"}
									</td>
									<td className="num py-2.5 pr-3">
										{formatBytes(object.sourceBytes)}
										{object.outcome === "recompressed" && (
											<> → {formatBytes(object.resultBytes)}</>
										)}
									</td>
									<td className="py-2.5">
										{OUTCOME_LABEL[object.outcome]}
										{object.smaskDropped ? " · smask" : ""}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</li>
	);
}

const OUTCOME_LABEL: Record<ObjectOutcome, string> = {
	recompressed: "recomprimida",
	"below-threshold": "ok",
	unplaced: "sin dibujar",
	stencil: "stencil",
	grew: "sin ganancia",
	"smask-removed": "smask fuera",
	failed: "falló",
};

function Fact({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<dt className="label">{label}</dt>
			<dd className="num mt-1 text-sm text-[var(--color-ink)]">{value}</dd>
		</div>
	);
}
