/**
 * Shared contracts between the UI thread and the compression worker.
 * Everything here is structured-clone safe.
 */

/** Knobs that fully determine the output for a given input file. */
export interface CompressSettings {
	/** Resolution ceiling in pixels per inch, measured at the placement rect. */
	targetPpi: number;
	/** JPEG quality for colour images, 50-95. */
	quality: number;
}

export interface Preset extends CompressSettings {
	id: PresetId;
	label: string;
	hint: string;
}

export type PresetId = "max" | "balanced" | "light";

/** Why a given image XObject was left untouched or rewritten. */
export type ObjectOutcome =
	| "recompressed"
	| "below-threshold"
	| "unplaced"
	| "stencil"
	| "grew"
	| "smask-removed"
	| "failed";

/** Per-object accounting, useful for the report and for debugging bad output. */
export interface ObjectReport {
	xref: number;
	outcome: ObjectOutcome;
	sourceBytes: number;
	resultBytes: number;
	pixelWidth: number;
	pixelHeight: number;
	newPixelWidth: number;
	newPixelHeight: number;
	effectivePpi: number;
	colorSpace: string;
	smaskDropped: boolean;
}

export interface CompressStats {
	originalBytes: number;
	resultBytes: number;
	/** Total bytes of image streams before rewriting. */
	imageBytesBefore: number;
	/** Total bytes of image streams after rewriting. */
	imageBytesAfter: number;
	imagesTotal: number;
	imagesRecompressed: number;
	imagesSkipped: number;
	smasksDropped: number;
	pageCount: number;
	elapsedMs: number;
	/** True when compression backfired and the original was returned as-is. */
	returnedOriginal: boolean;
	objects: ObjectReport[];
}

export interface CompressResult {
	bytes: Uint8Array;
	stats: CompressStats;
}

/* ------------------------------------------------------------------ worker ---- */

export interface WorkerRequest {
	kind: "compress";
	/** Correlates responses with a queue entry. */
	jobId: string;
	fileName: string;
	/** Transferred, not copied. */
	buffer: ArrayBuffer;
	settings: CompressSettings;
}

export type WorkerResponse =
	| { kind: "ready" }
	| { kind: "phase"; jobId: string; phase: JobPhase; detail: string }
	| {
			kind: "progress";
			jobId: string;
			/** Objects finished so far. */
			current: number;
			/** Objects that will be visited in total. */
			total: number;
			/** Bytes saved on image streams so far. */
			bytesSaved: number;
	  }
	| { kind: "done"; jobId: string; buffer: ArrayBuffer; stats: CompressStats }
	| { kind: "error"; jobId: string; message: string };

export type JobPhase =
	| "queued"
	| "loading"
	| "analyzing"
	| "recompressing"
	| "saving"
	| "done"
	| "error";

/* ---------------------------------------------------------------- ui state ---- */

export interface QueueItem {
	id: string;
	file: File;
	phase: JobPhase;
	detail: string;
	/** 0..1, -1 while indeterminate. */
	progress: number;
	current: number;
	total: number;
	originalBytes: number;
	resultBytes: number;
	bytesSaved: number;
	stats: CompressStats | null;
	resultUrl: string | null;
	resultName: string;
	error: string | null;
}
