/// <reference lib="webworker" />

/**
 * Runs the whole compression pipeline off the main thread. One job at a time,
 * strictly sequential: two documents decoded at once would double peak memory
 * for no throughput gain, since the work is CPU bound.
 */

import { CompressAbortError, compressPdf, describeError, loadEngine } from "../lib/compress";
import type { WorkerIncoming, WorkerResponse } from "../lib/types";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(message: WorkerResponse, transfer?: Transferable[]): void {
	if (transfer && transfer.length > 0) ctx.postMessage(message, transfer);
	else ctx.postMessage(message);
}

void loadEngine().then(
	() => post({ kind: "ready" }),
	(error: unknown) => {
		post({
			kind: "error",
			jobId: "",
			message: `no se pudo cargar el motor: ${describeError(error)}`,
		});
	},
);

let chain: Promise<void> = Promise.resolve();
const controllers = new Map<string, AbortController>();
/** Jobs cancelled before their turn in the chain. */
const skipped = new Set<string>();

ctx.addEventListener("message", (event: MessageEvent<WorkerIncoming>) => {
	const request = event.data;
	if (request.kind === "cancel") {
		skipped.add(request.jobId);
		controllers.get(request.jobId)?.abort();
		return;
	}
	if (request.kind !== "compress") return;

	const controller = new AbortController();
	controllers.set(request.jobId, controller);
	chain = chain
		.then(() => run(request, controller.signal))
		.finally(() => {
			controllers.delete(request.jobId);
			skipped.delete(request.jobId);
		});
});

async function run(
	request: Extract<WorkerIncoming, { kind: "compress" }>,
	signal: AbortSignal,
): Promise<void> {
	const { jobId, settings } = request;
	if (skipped.has(jobId) || signal.aborted) {
		post({ kind: "cancelled", jobId });
		return;
	}

	try {
		const input = new Uint8Array(request.buffer);
		const result = await compressPdf(input, settings, {
			signal,
			onPhase: (phase, detail) => post({ kind: "phase", jobId, phase, detail }),
			onProgress: ({ current, total, bytesSaved }) =>
				post({ kind: "progress", jobId, current, total, bytesSaved }),
		});

		if (signal.aborted || skipped.has(jobId)) {
			post({ kind: "cancelled", jobId });
			return;
		}

		const out = result.bytes;
		const buffer =
			out.byteOffset === 0 && out.byteLength === out.buffer.byteLength
				? (out.buffer as ArrayBuffer)
				: (out.slice().buffer as ArrayBuffer);

		post({ kind: "done", jobId, buffer, stats: result.stats }, [buffer]);
	} catch (error) {
		if (error instanceof CompressAbortError || signal.aborted || skipped.has(jobId)) {
			post({ kind: "cancelled", jobId });
			return;
		}
		post({ kind: "error", jobId, message: describeError(error) });
	}
}
