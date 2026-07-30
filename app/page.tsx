"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Dropzone from "../components/Dropzone";
import FileRow from "../components/FileRow";
import PreviewCompare from "../components/PreviewCompare";
import { formatBytes, formatPercent, outputName, savedFraction } from "../lib/format";
import {
	DEFAULT_PRESET_ID,
	PPI_MAX,
	PPI_MIN,
	PRESETS,
	QUALITY_MAX,
	QUALITY_MIN,
	clampSettings,
	getPreset,
	matchPreset,
} from "../lib/presets";
import type {
	CompressSettings,
	QueueItem,
	WorkerRequest,
	WorkerResponse,
} from "../lib/types";

interface ComparePayload {
	title: string;
	before: Uint8Array;
	after: Uint8Array;
}

export default function Page() {
	const initial = getPreset(DEFAULT_PRESET_ID);
	const [settings, setSettings] = useState<CompressSettings>({
		targetPpi: initial.targetPpi,
		quality: initial.quality,
	});
	const [items, setItems] = useState<QueueItem[]>([]);
	const [engineReady, setEngineReady] = useState(false);
	const [engineError, setEngineError] = useState<string | null>(null);
	const [compare, setCompare] = useState<ComparePayload | null>(null);

	const workerRef = useRef<Worker | null>(null);
	// Original bytes per job, kept for the comparator. Dropped on removal.
	const sourcesRef = useRef<Map<string, Uint8Array>>(new Map());
	const resultsRef = useRef<Map<string, Uint8Array>>(new Map());
	const urlsRef = useRef<Map<string, string>>(new Map());

	const patch = useCallback((id: string, changes: Partial<QueueItem>) => {
		setItems((current) =>
			current.map((item) => (item.id === id ? { ...item, ...changes } : item)),
		);
	}, []);

	useEffect(() => {
		const worker = new Worker(new URL("../workers/compress.worker.ts", import.meta.url), {
			type: "module",
			name: "pdf-compress",
		});
		workerRef.current = worker;

		worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
			const message = event.data;
			switch (message.kind) {
				case "ready":
					setEngineReady(true);
					break;
				case "phase":
					patch(message.jobId, {
						phase: message.phase,
						detail: message.detail,
						// Analysis has no countable unit of work; show it as indeterminate.
						progress: message.phase === "saving" ? 0.97 : -1,
					});
					break;
				case "progress":
					patch(message.jobId, {
						phase: "recompressing",
						current: message.current,
						total: message.total,
						bytesSaved: message.bytesSaved,
						progress:
							message.total > 0 ? (message.current / message.total) * 0.95 : -1,
					});
					break;
				case "done": {
					const bytes = new Uint8Array(message.buffer);
					resultsRef.current.set(message.jobId, bytes);
					const url = URL.createObjectURL(
						new Blob([bytes as unknown as BlobPart], { type: "application/pdf" }),
					);
					const previous = urlsRef.current.get(message.jobId);
					if (previous) URL.revokeObjectURL(previous);
					urlsRef.current.set(message.jobId, url);
					patch(message.jobId, {
						phase: "done",
						detail: "",
						progress: 1,
						resultBytes: bytes.byteLength,
						stats: message.stats,
						resultUrl: url,
					});
					break;
				}
				case "error":
					if (message.jobId === "") {
						setEngineError(message.message);
					} else {
						patch(message.jobId, {
							phase: "error",
							detail: "",
							progress: 0,
							error: message.message,
						});
					}
					break;
			}
		});

		worker.addEventListener("error", (event: ErrorEvent) => {
			setEngineError(event.message || "el worker de compresión falló");
		});

		return () => {
			worker.terminate();
			workerRef.current = null;
			for (const url of urlsRef.current.values()) URL.revokeObjectURL(url);
			urlsRef.current.clear();
			sourcesRef.current.clear();
			resultsRef.current.clear();
		};
	}, [patch]);

	const enqueue = useCallback(
		async (files: File[]) => {
			const worker = workerRef.current;
			if (!worker) return;

			for (const file of files) {
				const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
				const entry: QueueItem = {
					id,
					file,
					phase: "queued",
					detail: "",
					progress: -1,
					current: 0,
					total: 0,
					originalBytes: file.size,
					resultBytes: 0,
					bytesSaved: 0,
					stats: null,
					resultUrl: null,
					resultName: outputName(file.name, settings.targetPpi),
					error: null,
				};
				setItems((current) => [...current, entry]);

				try {
					const source = new Uint8Array(await file.arrayBuffer());
					// The worker receives a transferable copy; this one stays here so
					// the comparator can still show the original afterwards.
					sourcesRef.current.set(id, source);
					const copy = source.slice();
					const request: WorkerRequest = {
						kind: "compress",
						jobId: id,
						fileName: file.name,
						buffer: copy.buffer as ArrayBuffer,
						settings,
					};
					worker.postMessage(request, [request.buffer]);
				} catch (error: unknown) {
					patch(id, {
						phase: "error",
						error: error instanceof Error ? error.message : "no se pudo leer el archivo",
					});
				}
			}
		},
		[settings, patch],
	);

	const remove = useCallback((id: string) => {
		const url = urlsRef.current.get(id);
		if (url) URL.revokeObjectURL(url);
		urlsRef.current.delete(id);
		sourcesRef.current.delete(id);
		resultsRef.current.delete(id);
		setItems((current) => current.filter((item) => item.id !== id));
	}, []);

	const openCompare = useCallback(
		(id: string) => {
			const before = sourcesRef.current.get(id);
			const after = resultsRef.current.get(id);
			const item = items.find((candidate) => candidate.id === id);
			if (!before || !after || !item) return;
			setCompare({ title: item.file.name, before, after });
		},
		[items],
	);

	const activePreset = matchPreset(settings);
	const busy = items.some((item) => item.phase !== "done" && item.phase !== "error");

	const totals = useMemo(() => {
		const finished = items.filter((item) => item.phase === "done");
		const original = finished.reduce((sum, item) => sum + item.originalBytes, 0);
		const result = finished.reduce((sum, item) => sum + item.resultBytes, 0);
		return { count: finished.length, original, result };
	}, [items]);

	return (
		<main className="mx-auto max-w-5xl px-4 py-10">
			<header className="border-b border-ink-200 pb-6">
				<h1 className="text-lg text-ink-900">PDF Shrink</h1>
				<p className="mt-2 max-w-2xl text-sm text-ink-500">
					Baja la resolución de las imágenes sobredimensionadas de un PDF. No toca texto,
					fuentes, vectores ni anotaciones, y nunca rasteriza páginas enteras. Todo corre en
					el navegador: el archivo no se sube a ningún lado.
				</p>
				<p className="mt-2 text-xs text-ink-400">
					Motor:{" "}
					<span className="num">
						{engineError ? "no disponible" : engineReady ? "mupdf wasm listo" : "cargando…"}
					</span>
				</p>
				{engineError && <p className="mt-2 text-xs text-ink-700">{engineError}</p>}
			</header>

			<section className="mt-8" aria-labelledby="presets-heading">
				<h2 id="presets-heading" className="text-sm text-ink-900">
					Calidad
				</h2>
				<div className="mt-3 grid grid-cols-1 gap-px bg-ink-200 sm:grid-cols-3">
					{PRESETS.map((preset) => {
						const active = activePreset?.id === preset.id;
						return (
							<button
								key={preset.id}
								type="button"
								aria-pressed={active}
								onClick={() =>
									setSettings({ targetPpi: preset.targetPpi, quality: preset.quality })
								}
								className={[
									"px-4 py-3 text-left",
									active ? "bg-ink-800 text-ink-50" : "bg-white text-ink-900 hover:bg-ink-100",
								].join(" ")}
							>
								<span className="block text-sm">{preset.label}</span>
								<span
									className={[
										"num mt-1 block text-xs",
										active ? "text-ink-200" : "text-ink-400",
									].join(" ")}
								>
									{preset.hint}
								</span>
							</button>
						);
					})}
				</div>

				<div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
					<Slider
						label="Resolución objetivo"
						unit="ppi"
						min={PPI_MIN}
						max={PPI_MAX}
						step={1}
						value={settings.targetPpi}
						onChange={(targetPpi) => setSettings((s) => clampSettings({ ...s, targetPpi }))}
					/>
					<Slider
						label="Calidad JPEG"
						unit="q"
						min={QUALITY_MIN}
						max={QUALITY_MAX}
						step={1}
						value={settings.quality}
						onChange={(quality) => setSettings((s) => clampSettings({ ...s, quality }))}
					/>
				</div>
				<p className="mt-3 text-xs text-ink-400">
					{activePreset
						? `Preset: ${activePreset.label}.`
						: "Ajuste manual."}{" "}
					Sólo se recomprimen las imágenes que superan{" "}
					<span className="num">{Math.round(settings.targetPpi * 1.15)}</span> ppi efectivos;
					el resto queda intacto. Los cambios afectan a los archivos que agregues después.
				</p>
			</section>

			<section className="mt-8" aria-labelledby="queue-heading">
				<h2 id="queue-heading" className="sr-only">
					Cola de archivos
				</h2>
				<Dropzone onFiles={(files) => void enqueue(files)} disabled={engineError !== null} />

				{items.length > 0 && (
					<ul className="mt-4 space-y-2">
						{items.map((item) => (
							<FileRow key={item.id} item={item} onRemove={remove} onCompare={openCompare} />
						))}
					</ul>
				)}

				{totals.count > 1 && (
					<p className="mt-4 border-t border-ink-200 pt-3 text-xs text-ink-500">
						<span className="num">{totals.count}</span> archivos terminados ·{" "}
						<span className="num">{formatBytes(totals.original)}</span> &rarr;{" "}
						<span className="num">{formatBytes(totals.result)}</span> ·{" "}
						<span className="num">
							−{formatPercent(savedFraction(totals.original, totals.result))}
						</span>
					</p>
				)}
				{busy && (
					<p className="mt-4 text-xs text-ink-400">
						Procesando en un worker: la interfaz sigue respondiendo.
					</p>
				)}
			</section>

			{compare && (
				<PreviewCompare
					title={compare.title}
					before={compare.before}
					after={compare.after}
					onClose={() => setCompare(null)}
				/>
			)}
		</main>
	);
}

interface SliderProps {
	label: string;
	unit: string;
	min: number;
	max: number;
	step: number;
	value: number;
	onChange: (value: number) => void;
}

function Slider({ label, unit, min, max, step, value, onChange }: SliderProps) {
	return (
		<label className="block">
			<span className="flex items-baseline justify-between text-xs text-ink-500">
				{label}
				<span className="num text-ink-900">
					{value} {unit}
				</span>
			</span>
			<input
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
				onChange={(event) => onChange(Number(event.target.value))}
				className="mt-1 w-full"
			/>
			<span className="num mt-1 flex justify-between text-[10px] text-ink-300">
				<span>{min}</span>
				<span>{max}</span>
			</span>
		</label>
	);
}
