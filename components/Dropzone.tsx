"use client";

import { useCallback, useId, useRef, useState } from "react";

interface DropzoneProps {
	onFiles: (files: File[]) => void;
	disabled: boolean;
	/** Sit inside a chassis without doubling the outer border. */
	flush?: boolean;
}

function pdfsOnly(list: FileList | null): File[] {
	if (!list) return [];
	return Array.from(list).filter(
		(file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"),
	);
}

export default function Dropzone({ onFiles, disabled, flush = false }: DropzoneProps) {
	const [dragging, setDragging] = useState(false);
	const [rejected, setRejected] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const inputId = useId();
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
					"px-6 py-16 text-center transition-colors duration-150 sm:py-20",
					flush ? "" : "border border-[var(--color-rule)]",
					dragging ? "bg-[var(--color-paper)]" : "bg-[var(--color-surface)]",
					disabled ? "opacity-50" : "cursor-pointer",
				].join(" ")}
				onClick={() => {
					if (!disabled) inputRef.current?.click();
				}}
				onKeyDown={(event) => {
					if (disabled) return;
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						inputRef.current?.click();
					}
				}}
				role="button"
				tabIndex={disabled ? -1 : 0}
				aria-disabled={disabled}
				aria-label="Elegir archivos PDF"
			>
				<p
					className={[
						"text-[1.0625rem]",
						dragging ? "text-[var(--color-accent)]" : "text-[var(--color-ink)]",
					].join(" ")}
				>
					{dragging ? "Soltá para agregar" : "Arrastrá un PDF"}
				</p>
				<p className="mt-2 text-sm text-[var(--color-mute)]">
					o{" "}
					<label
						htmlFor={inputId}
						className="cursor-pointer text-[var(--color-ink)] underline decoration-[var(--color-rule)] underline-offset-4 hover:decoration-[var(--color-ink)]"
						onClick={(event) => event.stopPropagation()}
					>
						elegí del disco
					</label>
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
						event.target.value = "";
					}}
				/>
			</div>
			{rejected > 0 && (
				<p className="border-t border-[var(--color-rule)] px-5 py-3 text-xs text-[var(--color-mute)]">
					<span className="num text-[var(--color-ink)]">{rejected}</span> ignorado(s): sólo PDF.
				</p>
			)}
		</div>
	);
}
