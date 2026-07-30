"use client";

import { useCallback, useId, useRef, useState } from "react";

interface DropzoneProps {
	onFiles: (files: File[]) => void;
	disabled: boolean;
}

function pdfsOnly(list: FileList | null): File[] {
	if (!list) return [];
	return Array.from(list).filter(
		(file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"),
	);
}

export default function Dropzone({ onFiles, disabled }: DropzoneProps) {
	const [dragging, setDragging] = useState(false);
	const [rejected, setRejected] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const inputId = useId();
	// dragenter/dragleave fire for descendants too; a counter avoids flicker.
	const depth = useRef(0);

	const accept = useCallback(
		(list: FileList | null) => {
			const files = pdfsOnly(list);
			const total = list ? list.length : 0;
			setRejected(total - files.length);
			if (files.length > 0) onFiles(files);
		},
		[onFiles],
	);

	return (
		<div>
			<div
				onDragEnter={(event) => {
					event.preventDefault();
					depth.current += 1;
					if (!disabled) setDragging(true);
				}}
				onDragOver={(event) => {
					event.preventDefault();
				}}
				onDragLeave={(event) => {
					event.preventDefault();
					depth.current -= 1;
					if (depth.current <= 0) {
						depth.current = 0;
						setDragging(false);
					}
				}}
				onDrop={(event) => {
					event.preventDefault();
					depth.current = 0;
					setDragging(false);
					if (disabled) return;
					accept(event.dataTransfer.files);
				}}
				className={[
					"border border-dashed px-6 py-10 text-center transition-colors",
					dragging ? "border-ink-800 bg-ink-100" : "border-ink-300 bg-white",
					disabled ? "opacity-60" : "",
				].join(" ")}
			>
				<p className="text-sm text-ink-700">
					Arrastrá archivos PDF acá, o{" "}
					<label
						htmlFor={inputId}
						className="cursor-pointer underline decoration-ink-400 underline-offset-2 hover:decoration-ink-800"
					>
						elegilos del disco
					</label>
					.
				</p>
				<p className="mt-2 text-xs text-ink-400">
					Se procesan de a uno, en orden. El archivo nunca sale de tu navegador.
				</p>
				<input
					id={inputId}
					ref={inputRef}
					type="file"
					accept="application/pdf,.pdf"
					multiple
					disabled={disabled}
					className="sr-only"
					onChange={(event) => {
						accept(event.target.files);
						// Allow re-selecting the same file after removing it from the queue.
						event.target.value = "";
					}}
				/>
			</div>
			{rejected > 0 && (
				<p className="mt-2 text-xs text-ink-500">
					<span className="num">{rejected}</span> archivo(s) ignorado(s): sólo se aceptan PDF.
				</p>
			)}
		</div>
	);
}
