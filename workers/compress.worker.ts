/// <reference lib="webworker" />

/**
 * Runs the whole compression pipeline off the main thread. One job at a time,
 * strictly sequential: two documents decoded at once would double peak memory
 * for no throughput gain, since the work is CPU bound.
 */

import { compressPdf, describeError, loadEngine } from "../lib/compress";
import type { WorkerRequest, WorkerResponse } from "../lib/types";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(message: WorkerResponse, transfer?: Transferable[]): void {
	if (transfer && transfer.length > 0) ctx.postMessage(message, transfer);
	else ctx.postMessage(message);
}

// Warm the WASM module up front so the first file does not pay for the download.
void loadEngine().then(
	() => post({ kind: "ready" }),
	(error: unknown) => {
		post({ kind: "error", jobId: "", message: `no se pudo cargar el motor: ${describeError(error)}` });
	},
);

let chain: Promise<void> = Promise.resolve();

ctx.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
	const request = event.data;
	if (request.kind !== "compress") return;
	// Queue instead of running concurrently.
	chain = chain.then(() => run(request));
});

async function run(request: WorkerRequest): Promise<void> {
	const { jobId, settings } = request;
	try {
		const input = new Uint8Array(request.buffer);

		const result = await compressPdf(input, settings, {
			onPhase: (phase, detail) => post({ kind: "phase", jobId, phase, detail }),
			onProgress: ({ current, total, bytesSaved }) =>
				post({ kind: "progress", jobId, current, total, bytesSaved }),
		});

		// `bytes` may be the input array itself when compression backfired; either
		// way its buffer is ours to hand over.
		const out = result.bytes;
		const buffer =
			out.byteOffset === 0 && out.byteLength === out.buffer.byteLength
				? (out.buffer as ArrayBuffer)
				: (out.slice().buffer as ArrayBuffer);

		post({ kind: "done", jobId, buffer, stats: result.stats }, [buffer]);
	} catch (error) {
		post({ kind: "error", jobId, message: describeError(error) });
	}
}
