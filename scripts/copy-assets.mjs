// Copies the WASM engine and the pdf.js worker into /public so they are served
// as plain static files. Nothing here is bundled: the compression worker loads
// /mupdf/mupdf.js at runtime, which keeps mupdf's top-level `await` and its
// relative .wasm lookup out of the bundler's way entirely.
import { mkdirSync, copyFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @type {Array<{from: string, to: string}>} */
const assets = [
	// mupdf.js imports "./mupdf-wasm.js", which in turn resolves
	// "mupdf-wasm.wasm" relative to its own import.meta.url. All three must sit
	// in the same directory for that chain to resolve.
	{ from: "node_modules/mupdf/dist/mupdf.js", to: "public/mupdf/mupdf.js" },
	{ from: "node_modules/mupdf/dist/mupdf-wasm.js", to: "public/mupdf/mupdf-wasm.js" },
	{ from: "node_modules/mupdf/dist/mupdf-wasm.wasm", to: "public/mupdf/mupdf-wasm.wasm" },
	// pdf.js only powers the before/after preview.
	{ from: "node_modules/pdfjs-dist/build/pdf.worker.min.mjs", to: "public/pdfjs/pdf.worker.min.mjs" },
];

let copied = 0;
for (const { from, to } of assets) {
	const src = join(root, from);
	const dst = join(root, to);
	if (!existsSync(src)) {
		console.error(`[copy-assets] missing dependency file: ${from}\nRun \`npm install\` first.`);
		process.exit(1);
	}
	mkdirSync(dirname(dst), { recursive: true });
	copyFileSync(src, dst);
	copied++;
	console.log(`[copy-assets] ${to}  (${(statSync(dst).size / 1024).toFixed(0)} KB)`);
}
console.log(`[copy-assets] ${copied} file(s) ready in /public`);
