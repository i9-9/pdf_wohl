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
		<main className="mx-auto w-full max-w-[1120px] px-6 pb-24 pt-14 sm:px-10 sm:pt-16">
			<header className="mb-14 grid grid-cols-12 items-end gap-x-8 gap-y-6">
				<div className="col-span-12 md:col-span-8">
					<h1 className="text-[2.5rem] font-medium leading-none tracking-[-0.03em] text-[var(--color-ink)] sm:text-[3.25rem]">
						PDF Wohl
					</h1>
					<p className="mt-5 max-w-xl text-[0.9375rem] leading-relaxed text-[var(--color-mute)]">
						Baja la resolución de imágenes sobredimensionadas. Texto y vectores intactos.
						Nada sale del navegador.
					</p>
				</div>
				<div className="col-span-12 flex flex-col justify-end md:col-span-4 md:items-end">
					<p className="label">Estado</p>
					<p className="mt-2 flex items-center gap-2 text-sm text-[var(--color-ink)] md:justify-end">
						<span
							aria-hidden
							className="inline-block size-1.5"
							style={{
								background: engineError
									? "var(--color-accent)"
									: engineReady
										? "var(--color-ready)"
										: "var(--color-faint)",
							}}
						/>
						<span className="num">
							{engineError ? "error" : engineReady ? "listo" : "…"}
						</span>
					</p>
					{engineError && (
						<p className="mt-2 text-sm text-[var(--color-accent)] md:text-right">{engineError}</p>
					)}
				</div>
			</header>

			<section className="mb-12" aria-labelledby="presets-heading">
				<div className="grid grid-cols-12 gap-x-8 gap-y-8">
					<div className="col-span-12 sm:col-span-3">
						<h2 id="presets-heading" className="label">
							Calidad
						</h2>
						<p className="mt-3 text-sm leading-relaxed text-[var(--color-mute)]">
							Umbral{" "}
							<span className="num text-[var(--color-ink)]">
								{Math.round(settings.targetPpi * 1.15)}
							</span>{" "}
							ppi. Por debajo, intacto.
						</p>
					</div>

					<div className="col-span-12 sm:col-span-9">
						<div className="grid grid-cols-3 gap-3" role="group" aria-label="Presets">
							{PRESETS.map((preset) => {
								const active = activePreset?.id === preset.id;
								return (
									<button
										key={preset.id}
										type="button"
										aria-pressed={active}
										onClick={() =>
											setSettings({
												targetPpi: preset.targetPpi,
												quality: preset.quality,
											})
										}
										className={[
											"px-4 py-4 text-left transition-colors duration-150",
											active
												? "bg-[var(--color-ink)] text-[var(--color-surface)]"
												: "bg-[var(--color-surface)] text-[var(--color-ink)] hover:bg-white",
										].join(" ")}
									>
										<span className="block text-[0.875rem]">{preset.label}</span>
										<span
											className={[
												"num mt-1.5 block text-[0.6875rem]",
												active ? "text-white/50" : "text-[var(--color-faint)]",
											].join(" ")}
										>
											{preset.hint}
										</span>
									</button>
								);
							})}
						</div>

						<div className="mt-10 grid grid-cols-1 gap-x-10 gap-y-10 sm:grid-cols-2">
							<Slider
								label="Resolución"
								unit="ppi"
								min={PPI_MIN}
								max={PPI_MAX}
								step={1}
								value={settings.targetPpi}
								onChange={(targetPpi) =>
									setSettings((s) => clampSettings({ ...s, targetPpi }))
								}
							/>
							<Slider
								label="JPEG"
								unit=""
								min={QUALITY_MIN}
								max={QUALITY_MAX}
								step={1}
								value={settings.quality}
								onChange={(quality) =>
									setSettings((s) => clampSettings({ ...s, quality }))
								}
							/>
						</div>
					</div>
				</div>
			</section>

			<section aria-labelledby="queue-heading">
				<div className="mb-4 grid grid-cols-12 items-baseline gap-x-8">
					<h2 id="queue-heading" className="label col-span-6">
						Archivos
					</h2>
					<p className="col-span-6 text-right text-xs text-[var(--color-mute)]">
						{busy ? (
							"Procesando"
						) : items.length > 0 ? (
							<span className="num text-[var(--color-faint)]">{items.length}</span>
						) : null}
					</p>
				</div>

				<div className="chassis overflow-hidden">
					<Dropzone
						onFiles={(files) => void enqueue(files)}
						disabled={engineError !== null}
						flush
					/>

					{items.length > 0 && (
						<ul>
							{items.map((item) => (
								<FileRow
									key={item.id}
									item={item}
									onRemove={remove}
									onCompare={openCompare}
								/>
							))}
						</ul>
					)}
				</div>

				{totals.count > 1 && (
					<p className="mt-5 text-xs text-[var(--color-mute)]">
						<span className="num text-[var(--color-ink)]">{totals.count}</span>
						{" archivos · "}
						<span className="num">{formatBytes(totals.original)}</span>
						{" → "}
						<span className="num text-[var(--color-ink)]">{formatBytes(totals.result)}</span>
						{" · "}
						<span className="num text-[var(--color-accent)]">
							−{formatPercent(savedFraction(totals.original, totals.result))}
						</span>
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
		<label className="block w-full">
			<span className="flex items-baseline justify-between gap-4">
				<span className="label">{label}</span>
				<span className="num text-[1.375rem] leading-none text-[var(--color-ink)]">
					{value}
					{unit ? (
						<span className="ml-1.5 text-[0.8125rem] text-[var(--color-faint)]">{unit}</span>
					) : null}
				</span>
			</span>
			<input
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
				onChange={(event) => onChange(Number(event.target.value))}
				className="mt-5 w-full"
			/>
			<span className="num mt-1 flex justify-between text-[0.6875rem] text-[var(--color-faint)]">
				<span>{min}</span>
				<span>{max}</span>
			</span>
		</label>
	);
}
