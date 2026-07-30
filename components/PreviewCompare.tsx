"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { formatBytes } from "../lib/format";

interface PreviewCompareProps {
	title: string;
	/** Original bytes. Copies are kept because pdf.js detaches what it receives. */
	before: Uint8Array;
	after: Uint8Array;
	onClose: () => void;
}

const ZOOM_STEPS = [0.5, 0.75, 1, 1.5, 2, 3, 4] as const;
const DEFAULT_ZOOM_INDEX = 2;

type Side = "before" | "after";

interface Loaded {
	before: PDFDocumentProxy;
	after: PDFDocumentProxy;
	pageCount: number;
}

/**
 * pdf.js is loaded lazily and only here: it exists to prove the output still
 * renders, and should not be part of the initial payload.
 */
async function openBoth(before: Uint8Array, after: Uint8Array): Promise<Loaded> {
	const pdfjs = await import("pdfjs-dist");
	pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";

	const load = (bytes: Uint8Array): Promise<PDFDocumentProxy> =>
		pdfjs.getDocument({
			// pdf.js takes ownership of the buffer it is handed, so each side gets
			// its own copy and the caller's arrays stay intact for downloads.
			data: bytes.slice(),
			isEvalSupported: false,
		}).promise;

	const [beforeDoc, afterDoc] = await Promise.all([load(before), load(after)]);
	return {
		before: beforeDoc,
		after: afterDoc,
		pageCount: Math.min(beforeDoc.numPages, afterDoc.numPages),
	};
}

export default function PreviewCompare({ title, before, after, onClose }: PreviewCompareProps) {
	const [docs, setDocs] = useState<Loaded | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pageNumber, setPageNumber] = useState(1);
	const [zoomIndex, setZoomIndex] = useState<number>(DEFAULT_ZOOM_INDEX);
	const zoom = ZOOM_STEPS[zoomIndex] ?? 1;

	const beforeCanvas = useRef<HTMLCanvasElement>(null);
	const afterCanvas = useRef<HTMLCanvasElement>(null);
	// Both panes scroll as one so the eye compares the same region.
	const beforePane = useRef<HTMLDivElement>(null);
	const afterPane = useRef<HTMLDivElement>(null);
	const syncing = useRef(false);

	useEffect(() => {
		let cancelled = false;
		let opened: Loaded | null = null;

		openBoth(before, after).then(
			(loaded) => {
				if (cancelled) {
					void loaded.before.destroy();
					void loaded.after.destroy();
					return;
				}
				opened = loaded;
				setDocs(loaded);
			},
			(reason: unknown) => {
				if (!cancelled) {
					setError(reason instanceof Error ? reason.message : "no se pudo abrir el PDF");
				}
			},
		);

		return () => {
			cancelled = true;
			if (opened) {
				void opened.before.destroy();
				void opened.after.destroy();
			}
		};
	}, [before, after]);

	const renderSide = useCallback(
		async (side: Side, loaded: Loaded, page: number, scale: number) => {
			const doc = side === "before" ? loaded.before : loaded.after;
			const canvas = side === "before" ? beforeCanvas.current : afterCanvas.current;
			if (!canvas) return;

			const pdfPage = await doc.getPage(page);
			// Cap the backing store so a 1920x1080pt slide at 4x does not allocate
			// hundreds of megabytes of canvas.
			const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
			const viewport = pdfPage.getViewport({ scale: scale * dpr });
			const context = canvas.getContext("2d");
			if (!context) return;

			canvas.width = Math.floor(viewport.width);
			canvas.height = Math.floor(viewport.height);
			canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
			canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;

			context.setTransform(1, 0, 0, 1, 0, 0);
			context.fillStyle = "#ffffff";
			context.fillRect(0, 0, canvas.width, canvas.height);

			await pdfPage.render({ canvasContext: context, viewport }).promise;
			pdfPage.cleanup();
		},
		[],
	);

	useEffect(() => {
		if (!docs) return;
		let cancelled = false;
		void (async () => {
			try {
				await renderSide("before", docs, pageNumber, zoom);
				if (cancelled) return;
				await renderSide("after", docs, pageNumber, zoom);
			} catch (reason: unknown) {
				if (!cancelled) {
					setError(reason instanceof Error ? reason.message : "no se pudo renderizar la página");
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [docs, pageNumber, zoom, renderSide]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		globalThis.addEventListener("keydown", onKey);
		return () => globalThis.removeEventListener("keydown", onKey);
	}, [onClose]);

	const mirror = useCallback((from: Side) => {
		if (syncing.current) return;
		const source = from === "before" ? beforePane.current : afterPane.current;
		const target = from === "before" ? afterPane.current : beforePane.current;
		if (!source || !target) return;
		syncing.current = true;
		target.scrollLeft = source.scrollLeft;
		target.scrollTop = source.scrollTop;
		// Released on the next frame: assigning scroll positions fires scroll
		// events that would otherwise bounce back and forth.
		requestAnimationFrame(() => {
			syncing.current = false;
		});
	}, []);

	const pageOptions = useMemo(
		() => (docs ? Array.from({ length: docs.pageCount }, (_, index) => index + 1) : []),
		[docs],
	);

	return (
		<div className="fixed inset-0 z-50 flex flex-col bg-ink-50">
			<header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-ink-200 bg-white px-4 py-3">
				<h2 className="min-w-0 flex-1 truncate text-sm text-ink-900">{title}</h2>

				<label className="flex items-center gap-2 text-xs text-ink-500">
					Página
					<select
						value={pageNumber}
						disabled={!docs}
						onChange={(event) => setPageNumber(Number(event.target.value))}
						className="num border border-ink-300 bg-white px-2 py-1 text-xs text-ink-900"
					>
						{pageOptions.map((page) => (
							<option key={page} value={page}>
								{page}
							</option>
						))}
					</select>
					{docs && <span className="num text-ink-400">de {docs.pageCount}</span>}
				</label>

				<div className="flex items-center gap-2 text-xs text-ink-500">
					Zoom
					<button
						type="button"
						onClick={() => setZoomIndex((index) => Math.max(0, index - 1))}
						disabled={zoomIndex === 0}
						className="border border-ink-300 px-2 py-1 text-ink-900 disabled:opacity-40"
						aria-label="Alejar"
					>
						&minus;
					</button>
					<span className="num w-12 text-center text-ink-900">
						{Math.round(zoom * 100)}%
					</span>
					<button
						type="button"
						onClick={() => setZoomIndex((index) => Math.min(ZOOM_STEPS.length - 1, index + 1))}
						disabled={zoomIndex === ZOOM_STEPS.length - 1}
						className="border border-ink-300 px-2 py-1 text-ink-900 disabled:opacity-40"
						aria-label="Acercar"
					>
						+
					</button>
				</div>

				<button
					type="button"
					onClick={onClose}
					className="border border-ink-800 px-3 py-1 text-xs text-ink-900 hover:bg-ink-100"
				>
					Cerrar
				</button>
			</header>

			{error && (
				<p className="border-b border-ink-200 bg-white px-4 py-2 text-xs text-ink-700">{error}</p>
			)}
			{!docs && !error && (
				<p className="border-b border-ink-200 bg-white px-4 py-2 text-xs text-ink-500">
					Abriendo ambas versiones…
				</p>
			)}

			<div className="grid min-h-0 flex-1 grid-cols-1 gap-px bg-ink-200 md:grid-cols-2">
				<Pane
					ref={beforePane}
					label="Antes"
					weight={formatBytes(before.byteLength)}
					canvasRef={beforeCanvas}
					onScroll={() => mirror("before")}
				/>
				<Pane
					ref={afterPane}
					label="Después"
					weight={formatBytes(after.byteLength)}
					canvasRef={afterCanvas}
					onScroll={() => mirror("after")}
				/>
			</div>
		</div>
	);
}

interface PaneProps {
	ref: React.RefObject<HTMLDivElement | null>;
	label: string;
	weight: string;
	canvasRef: React.RefObject<HTMLCanvasElement | null>;
	onScroll: () => void;
}

function Pane({ ref, label, weight, canvasRef, onScroll }: PaneProps) {
	return (
		<section className="flex min-h-0 min-w-0 flex-col bg-ink-100">
			<div className="flex items-baseline justify-between border-b border-ink-200 bg-white px-3 py-1.5">
				<span className="text-xs text-ink-700">{label}</span>
				<span className="num text-xs text-ink-500">{weight}</span>
			</div>
			<div ref={ref} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto p-4">
				<canvas ref={canvasRef} className="block border border-ink-200 bg-white" />
			</div>
		</section>
	);
}
