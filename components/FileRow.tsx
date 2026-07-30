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
	queued: "en cola",
	loading: "abriendo",
	analyzing: "analizando",
	recompressing: "recomprimiendo",
	saving: "guardando",
	done: "listo",
	error: "error",
};

export default function FileRow({ item, onRemove, onCompare }: FileRowProps) {
	const [open, setOpen] = useState(false);
	const done = item.phase === "done";
	const failed = item.phase === "error";
	const running = !done && !failed && item.phase !== "queued";

	const saved = done ? savedFraction(item.originalBytes, item.resultBytes) : 0;
	const grew = done && item.stats?.returnedOriginal === true;

	return (
		<li className="border border-ink-200 bg-white">
			<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-3">
				<span className="min-w-0 flex-1 truncate text-sm text-ink-900" title={item.file.name}>
					{item.file.name}
				</span>

				<span className="num text-sm text-ink-500">{formatBytes(item.originalBytes)}</span>
				<span aria-hidden className="text-ink-300">
					&rarr;
				</span>
				<span className="num text-sm text-ink-900">
					{done ? formatBytes(item.resultBytes) : "—"}
				</span>
				<span
					className={[
						"num w-16 text-right text-sm",
						grew ? "text-ink-400" : done ? "text-ink-900" : "text-ink-300",
					].join(" ")}
				>
					{done ? (grew ? "0.0%" : `−${formatPercent(saved)}`) : "—"}
				</span>

				<div className="flex items-center gap-3">
					{done && item.resultUrl && (
						<a
							href={item.resultUrl}
							download={item.resultName}
							className="border border-ink-800 px-3 py-1 text-xs text-ink-900 hover:bg-ink-100"
						>
							Descargar
						</a>
					)}
					{done && (
						<button
							type="button"
							onClick={() => onCompare(item.id)}
							className="border border-ink-300 px-3 py-1 text-xs text-ink-700 hover:border-ink-800 hover:text-ink-900"
						>
							Comparar
						</button>
					)}
					{item.stats && (
						<button
							type="button"
							onClick={() => setOpen((value) => !value)}
							aria-expanded={open}
							className="text-xs text-ink-500 underline decoration-ink-300 underline-offset-2 hover:text-ink-900"
						>
							{open ? "Menos" : "Detalle"}
						</button>
					)}
					<button
						type="button"
						onClick={() => onRemove(item.id)}
						className="text-xs text-ink-400 hover:text-ink-900"
						aria-label={`Quitar ${item.file.name} de la cola`}
					>
						Quitar
					</button>
				</div>
			</div>

			<div className="px-4 pb-3">
				<div className="h-[2px] w-full bg-ink-200" role="presentation">
					<div
						className={failed ? "h-full bg-ink-400" : "h-full bg-ink-800"}
						style={{ width: `${Math.round((failed ? 1 : Math.max(0, item.progress)) * 100)}%` }}
					/>
				</div>
				<p className="mt-2 flex flex-wrap items-baseline gap-x-3 text-xs text-ink-500">
					<span>{PHASE_LABEL[item.phase]}</span>
					{item.detail && <span className="text-ink-400">{item.detail}</span>}
					{running && item.total > 0 && (
						<span className="num">
							objeto {item.current}/{item.total}
						</span>
					)}
					{running && item.bytesSaved > 0 && (
						<span className="num">−{formatBytes(item.bytesSaved)} acumulados</span>
					)}
					{done && item.stats && (
						<span className="num">
							{item.stats.imagesRecompressed}/{item.stats.imagesTotal} imágenes ·{" "}
							{formatDuration(item.stats.elapsedMs)}
						</span>
					)}
				</p>
				{failed && item.error && <p className="mt-1 text-xs text-ink-700">{item.error}</p>}
				{grew && (
					<p className="mt-1 text-xs text-ink-700">
						El resultado no era más chico que el original: se devuelve el archivo original sin
						cambios.
					</p>
				)}
			</div>

			{open && item.stats && (
				<div className="border-t border-ink-200 px-4 py-3">
					<dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
						<Fact label="Páginas" value={String(item.stats.pageCount)} />
						<Fact label="XObjects imagen" value={String(item.stats.imagesTotal)} />
						<Fact label="Recomprimidas" value={String(item.stats.imagesRecompressed)} />
						<Fact label="SMasks opacas quitadas" value={String(item.stats.smasksDropped)} />
						<Fact label="Imágenes antes" value={formatBytes(item.stats.imageBytesBefore)} />
						<Fact label="Imágenes después" value={formatBytes(item.stats.imageBytesAfter)} />
						<Fact
							label="Resto (texto, vectores)"
							value={formatBytes(
								Math.max(0, item.stats.originalBytes - item.stats.imageBytesBefore),
							)}
						/>
						<Fact label="Tiempo" value={formatDuration(item.stats.elapsedMs)} />
					</dl>

					<table className="mt-4 w-full border-collapse text-xs">
						<thead>
							<tr className="border-b border-ink-200 text-left text-ink-500">
								<th className="py-1 pr-3 font-normal">xref</th>
								<th className="py-1 pr-3 font-normal">píxeles</th>
								<th className="py-1 pr-3 font-normal">ppi</th>
								<th className="py-1 pr-3 font-normal">resultado</th>
								<th className="py-1 pr-3 font-normal">peso</th>
								<th className="py-1 font-normal">estado</th>
							</tr>
						</thead>
						<tbody className="text-ink-700">
							{item.stats.objects.map((object) => (
								<tr key={object.xref} className="border-b border-ink-100">
									<td className="num py-1 pr-3">{object.xref}</td>
									<td className="num py-1 pr-3">
										{object.pixelWidth}&times;{object.pixelHeight}
									</td>
									<td className="num py-1 pr-3">
										{object.effectivePpi > 0 ? object.effectivePpi.toFixed(0) : "—"}
									</td>
									<td className="num py-1 pr-3">
										{object.outcome === "recompressed"
											? `${object.newPixelWidth}\u00d7${object.newPixelHeight}`
											: "—"}
									</td>
									<td className="num py-1 pr-3">
										{formatBytes(object.sourceBytes)}
										{object.outcome === "recompressed" && (
											<> &rarr; {formatBytes(object.resultBytes)}</>
										)}
									</td>
									<td className="py-1 text-ink-500">
										{OUTCOME_LABEL[object.outcome]}
										{object.smaskDropped ? " · smask fuera" : ""}
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
	"below-threshold": "ya estaba bien",
	unplaced: "no se dibuja",
	stencil: "bilevel / stencil",
	grew: "no convenía",
	"smask-removed": "máscara opaca, eliminada",
	failed: "falló, intacta",
};

function Fact({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<dt className="text-ink-400">{label}</dt>
			<dd className="num text-ink-900">{value}</dd>
		</div>
	);
}
