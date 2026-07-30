/**
 * PDF image downsampling, UI-agnostic.
 *
 * Strategy: keep the document structure exactly as it is and rewrite only the
 * streams of image XObjects that are placed on a page at more pixels per inch
 * than requested. Content streams, Type 3 fonts, vectors and annotations are
 * never touched, and pages are never rasterised.
 *
 * Engine notes (verified against mupdf 1.28.0, not assumed):
 * - `PDFObject.writeRawStream` / `writeStream` / `writeObject` only work on an
 *   *indirect* reference, so every object is handled through
 *   `doc.newIndirect(xref)`. The same applies to `isStream()`, which reports
 *   false for an already-resolved dictionary.
 * - NEVER call `PDFObject.resolve()`. In this build, resolving an indirect
 *   reference and then saving with `garbage: "compact" | "deduplicate"` drops
 *   every object that was resolved: pages keep their `/XObject` entries but the
 *   objects behind them are gone, so the file silently loses all its images and
 *   looks like a spectacular compression win. `get()` and `getInheritable()`
 *   resolve internally in C and are safe, so nothing here needs `resolve()`.
 *   Reproduced with a resolve-only loop and no other mutation: 50.1 MB -> 13.9
 *   MB with 180/180 dangling image references.
 * - Grayscale data is deflated here with `CompressionStream("deflate")` (zlib
 *   wrapper, exactly what /FlateDecode expects) and stored with
 *   `writeRawStream`. Letting `writeStream` + save-time `compress` do it would
 *   work too, but then the final stream size is unknown until after saving,
 *   which makes per-object accounting and the "did this help?" check impossible.
 * - `Buffer.asUint8Array()` and `Pixmap.getPixels()` return *views into the
 *   WASM heap*. Any later allocation can grow that heap, which detaches the
 *   backing ArrayBuffer and silently turns the view into a zero-length array.
 *   Every such view is therefore copied out before anything else runs.
 * - `Image.toPixmap()` always decodes at full resolution; mupdf exposes no
 *   scaled decode, so resampling happens afterwards, in ./plane.
 * - `toPixmap()` decodes into the image's *own* colour space, ICC profile and
 *   all: an /ICCBased image comes back as an ICCBased pixmap with its values
 *   untouched, and `ColorSpace.getType()` reports plain "RGB" for it because
 *   mupdf's type enum has no ICC variant. Relabelling such an image
 *   /DeviceRGB therefore reinterprets wide-gamut values as sRGB and shifts
 *   every colour in it: an Adobe RGB (200,60,60) should display as sRGB
 *   (231,57,57), and a ProPhoto (70,90,200) as (0,113,221). Verified against
 *   real profiles, and the reason such images keep their /ColorSpace entry
 *   verbatim below rather than being converted.
 * - `convertToColorSpace` does perform a real colorimetric transform (this
 *   build has lcms: DeviceCMYK 0,255,255,0 converts to 237,28,36, not the
 *   255,0,0 a naive formula gives). It is still not used on wide-gamut RGB,
 *   because converting to sRGB would clip whatever falls outside it.
 */

import { encodeJpeg } from "./jpeg";
import { firstComponent, resampleArea, toRgba, type Plane, type Transfer } from "./plane";
import { REENCODE_MARGIN } from "./presets";
import type {
	CompressResult,
	CompressSettings,
	ObjectReport,
	ObjectOutcome,
} from "./types";

type MuPdf = typeof import("mupdf");
type MuDocument = import("mupdf").PDFDocument;
type MuPixmap = import("mupdf").Pixmap;
type MuPdfObject = import("mupdf").PDFObject;

export const DEFAULT_ENGINE_URL = "/mupdf/mupdf.js";

let enginePromise: Promise<MuPdf> | null = null;

/**
 * Loads mupdf's WASM build at runtime from /public instead of bundling it.
 * mupdf.js uses a top-level `await` and resolves `mupdf-wasm.wasm` relative to
 * its own URL; serving the three files side by side sidesteps both concerns and
 * keeps the .wasm out of the JS bundle.
 */
export function loadEngine(url: string = DEFAULT_ENGINE_URL): Promise<MuPdf> {
	if (!enginePromise) {
		enginePromise = import(/* webpackIgnore: true */ url).then(
			(mod) => mod as unknown as MuPdf,
		);
	}
	return enginePromise;
}

export interface ProgressReport {
	current: number;
	total: number;
	bytesSaved: number;
}

export interface CompressCallbacks {
	onPhase?: (phase: "loading" | "analyzing" | "recompressing" | "saving", detail: string) => void;
	onProgress?: (report: ProgressReport) => void;
	/** Checked between objects so Quitar can stop an in-flight job. */
	signal?: AbortSignal;
}

/** Thrown when `signal` aborts mid-compress. Not a failure of the document. */
export class CompressAbortError extends Error {
	override readonly name = "CompressAbortError";
	constructor() {
		super("cancelado");
	}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new CompressAbortError();
}

/** Facts read straight from an image XObject's dictionary. */
interface ImageEntry {
	xref: number;
	width: number;
	height: number;
	bpc: number;
	isStencil: boolean;
	colorSpace: string;
	streamBytes: number;
	smaskXref: number | null;
}

/** Largest area an image is drawn at, in PDF points. */
interface Placement {
	widthPt: number;
	heightPt: number;
}

/** Outcome of the decision pass for one image. */
interface Decision {
	entry: ImageEntry;
	newWidth: number;
	newHeight: number;
	effectivePpi: number;
}

const SMASK_OPAQUE_THRESHOLD = 250;

export async function compressPdf(
	input: Uint8Array,
	settings: CompressSettings,
	callbacks: CompressCallbacks = {},
): Promise<CompressResult> {
	const startedAt = Date.now();
	const mupdf = await loadEngine();
	const originalBytes = input.byteLength;

	callbacks.onPhase?.("loading", "Abriendo documento");
	throwIfAborted(callbacks.signal);
	// mupdf copies the bytes into the WASM heap; `input` stays owned by us.
	const doc = new mupdf.PDFDocument(input);

	try {
		const pageCount = doc.countPages();

		callbacks.onPhase?.("analyzing", "Inventario de imágenes");
		throwIfAborted(callbacks.signal);
		const images = collectImages(doc);

		callbacks.onPhase?.("analyzing", `Midiendo ${images.size} imagen(es) en ${pageCount} página(s)`);
		throwIfAborted(callbacks.signal);
		const placements = measurePlacements(mupdf, doc, images);

		// Objects that serve as somebody's soft mask are driven by their parent.
		const maskOwners = new Map<number, number[]>();
		for (const entry of images.values()) {
			if (entry.smaskXref === null) continue;
			const owners = maskOwners.get(entry.smaskXref);
			if (owners) owners.push(entry.xref);
			else maskOwners.set(entry.smaskXref, [entry.xref]);
		}

		// ---- decision pass: decide everything before mutating anything, so a
		// soft mask shared by several parents can be sized once, consistently.
		const reports = new Map<number, ObjectReport>();
		const decisions: Decision[] = [];

		for (const entry of images.values()) {
			if (maskOwners.has(entry.xref)) continue;

			const baseReport = blankReport(entry);

			if (entry.isStencil || entry.bpc === 1) {
				reports.set(entry.xref, { ...baseReport, outcome: "stencil" });
				continue;
			}
			const placement = placements.get(entry.xref);
			if (!placement || placement.widthPt <= 0) {
				reports.set(entry.xref, { ...baseReport, outcome: "unplaced" });
				continue;
			}

			const ppi = (72 * entry.width) / placement.widthPt;
			const ppiY = placement.heightPt > 0 ? (72 * entry.height) / placement.heightPt : ppi;
			// A single scale factor keeps the aspect ratio; the tighter of the two
			// axes decides, otherwise one axis would still be over budget.
			const effectivePpi = Math.max(ppi, ppiY);
			const withPpi = { ...baseReport, effectivePpi };

			if (effectivePpi <= settings.targetPpi * REENCODE_MARGIN) {
				reports.set(entry.xref, { ...withPpi, outcome: "below-threshold" });
				continue;
			}

			const scale = settings.targetPpi / effectivePpi;
			const newWidth = Math.max(1, Math.round(entry.width * scale));
			const newHeight = Math.max(1, Math.round(entry.height * scale));
			reports.set(entry.xref, { ...withPpi, newPixelWidth: newWidth, newPixelHeight: newHeight });
			decisions.push({ entry, newWidth, newHeight, effectivePpi });
		}

		// A mask shared by several parents is resampled once, to the largest of
		// the parents' new sizes. PDF scales a soft mask over the base image's
		// area, so this stays correct for every parent.
		const maskTargets = new Map<number, { width: number; height: number }>();
		for (const decision of decisions) {
			const maskXref = decision.entry.smaskXref;
			if (maskXref === null) continue;
			const prev = maskTargets.get(maskXref);
			maskTargets.set(maskXref, {
				width: Math.max(prev?.width ?? 0, decision.newWidth),
				height: Math.max(prev?.height ?? 0, decision.newHeight),
			});
		}

		// A fully opaque soft mask is dead weight whether or not its parent gets
		// re-encoded, so parents left below the ppi threshold still have to be
		// asked the question. In the reference deck 139 of the masks are exactly
		// this, and skipping the untouched parents would leave most of them in.
		const reencoded = new Set(decisions.map((d) => d.entry.xref));
		const maskOnlyParents = [...images.values()].filter(
			(entry) =>
				entry.smaskXref !== null && !reencoded.has(entry.xref) && !maskOwners.has(entry.xref),
		);

		// ---- execution pass
		const totalSteps = decisions.length + maskOnlyParents.length;
		callbacks.onPhase?.("recompressing", `${decisions.length} imagen(es) a recomprimir`);
		let bytesSaved = 0;
		let recompressed = 0;
		// A soft mask can be shared: decide once, then apply to every parent.
		const opaqueMasks = new Set<number>();
		const inspectedMasks = new Set<number>();
		const deletedMasks = new Set<number>();

		callbacks.onProgress?.({ current: 0, total: totalSteps, bytesSaved: 0 });

		/** Drops the /SMask reference, and the mask itself once nobody needs it. */
		const dropMaskFrom = (parentXref: number, maskXref: number, maskBytes: number): void => {
			doc.newIndirect(parentXref).delete("SMask");
			if (deletedMasks.has(maskXref)) return;
			deletedMasks.add(maskXref);
			doc.deleteObject(maskXref);
			bytesSaved += maskBytes;
			const mask = images.get(maskXref);
			if (mask) {
				reports.set(maskXref, {
					...blankReport(mask),
					outcome: "smask-removed",
					resultBytes: 0,
				});
			}
		};

		for (let i = 0; i < decisions.length; i++) {
			throwIfAborted(callbacks.signal);
			const decision = decisions[i];
			const { entry } = decision;
			const report = reports.get(entry.xref) ?? blankReport(entry);

			try {
				const maskXref = entry.smaskXref;
				const maskEntry = maskXref === null ? undefined : images.get(maskXref);

				// The mask is inspected before the parent's dictionary loses its
				// /SMask entry, and only once even when several parents share it.
				if (maskXref !== null && maskEntry && !inspectedMasks.has(maskXref)) {
					inspectedMasks.add(maskXref);
					const target = maskTargets.get(maskXref) ?? {
						width: decision.newWidth,
						height: decision.newHeight,
					};
					const mask = await processSoftMask(
						mupdf,
						doc,
						maskEntry,
						target.width,
						target.height,
					);
					if (mask.outcome === "opaque") {
						opaqueMasks.add(maskXref);
					} else {
						const resampled = mask.outcome === "resampled";
						if (resampled) bytesSaved += Math.max(0, maskEntry.streamBytes - mask.bytes);
						reports.set(maskXref, {
							...blankReport(maskEntry),
							outcome:
								mask.outcome === "resampled"
									? "recompressed"
									: mask.outcome === "bilevel"
										? "stencil"
										: "grew",
							resultBytes: mask.bytes,
							newPixelWidth: resampled ? target.width : maskEntry.width,
							newPixelHeight: resampled ? target.height : maskEntry.height,
						});
					}
				}

				const written = await rewriteImage(mupdf, doc, entry, decision, settings.quality);

				const dropMask = maskXref !== null && opaqueMasks.has(maskXref);
				if (dropMask && maskXref !== null) {
					dropMaskFrom(entry.xref, maskXref, maskEntry?.streamBytes ?? 0);
				}

				if (written.written) {
					bytesSaved += Math.max(0, entry.streamBytes - written.bytes);
					recompressed++;
				}
				reports.set(entry.xref, {
					...report,
					outcome: written.written ? "recompressed" : "grew",
					resultBytes: written.bytes,
					newPixelWidth: written.written ? decision.newWidth : entry.width,
					newPixelHeight: written.written ? decision.newHeight : entry.height,
					smaskDropped: dropMask,
				});
			} catch (error) {
				reports.set(entry.xref, {
					...report,
					outcome: "failed",
					resultBytes: entry.streamBytes,
				});
				console.warn(`xref ${entry.xref}: se deja intacta (${describeError(error)})`);
			}

			callbacks.onProgress?.({ current: i + 1, total: totalSteps, bytesSaved });
			// Let the worker's message queue drain so progress actually paints.
			await Promise.resolve();
		}

		// Parents that keep their own resolution but may still carry a useless
		// mask. A mask that genuinely does something is left exactly as it is:
		// its parent is not changing size, so there is nothing to realign.
		for (let i = 0; i < maskOnlyParents.length; i++) {
			throwIfAborted(callbacks.signal);
			const entry = maskOnlyParents[i];
			const maskXref = entry.smaskXref;
			const maskEntry = maskXref === null ? undefined : images.get(maskXref);
			if (maskXref !== null && maskEntry) {
				try {
					if (!inspectedMasks.has(maskXref)) {
						inspectedMasks.add(maskXref);
						if (isMaskFullyOpaque(mupdf, doc, maskEntry)) opaqueMasks.add(maskXref);
					}
					if (opaqueMasks.has(maskXref)) {
						dropMaskFrom(entry.xref, maskXref, maskEntry.streamBytes);
						const previous = reports.get(entry.xref);
						if (previous) reports.set(entry.xref, { ...previous, smaskDropped: true });
					}
				} catch (error) {
					console.warn(`xref ${maskXref}: máscara intacta (${describeError(error)})`);
				}
			}
			callbacks.onProgress?.({
				current: decisions.length + i + 1,
				total: totalSteps,
				bytesSaved,
			});
			await Promise.resolve();
		}

		throwIfAborted(callbacks.signal);
		callbacks.onPhase?.("saving", "Recolectando objetos y comprimiendo");
		const saved = doc.saveToBuffer({
			// Level 3: drop unreachable objects and merge duplicates.
			garbage: "deduplicate",
			// Deflate the streams we did not rewrite ourselves, content streams
			// above all -- that is where the non-image weight lives.
			compress: true,
			clean: true,
			// Image streams are already in their final encoding; re-filtering them
			// would only cost time and could re-encode what we just wrote.
			"compress-images": false,
			// `sanitize` is deliberately off: it rewrites content streams, and
			// those (including the vectorised Type 3 text) must be left alone.
		});
		// Copy out of the WASM heap immediately: see the note at the top.
		const output = saved.asUint8Array().slice();
		saved.destroy();

		const objects = [...reports.values()].sort((a, b) => a.xref - b.xref);
		const imageBytesBefore = objects.reduce((sum, o) => sum + o.sourceBytes, 0);
		const imageBytesAfter = objects.reduce((sum, o) => {
			if (o.outcome === "recompressed") return sum + o.resultBytes;
			// A removed mask contributes nothing: the object is gone.
			if (o.outcome === "smask-removed") return sum;
			return sum + o.sourceBytes;
		}, 0);

		const grewOrEqual = output.byteLength >= originalBytes;
		const resultBytes = grewOrEqual ? input : output;

		return {
			bytes: resultBytes,
			stats: {
				originalBytes,
				resultBytes: resultBytes.byteLength,
				imageBytesBefore,
				imageBytesAfter,
				imagesTotal: images.size,
				imagesRecompressed: recompressed,
				imagesSkipped: images.size - recompressed,
				smasksDropped: deletedMasks.size,
				pageCount,
				elapsedMs: Date.now() - startedAt,
				returnedOriginal: grewOrEqual,
				objects,
			},
		};
	} finally {
		doc.destroy();
	}
}

/* ------------------------------------------------------------- inventory ---- */

function collectImages(doc: MuDocument): Map<number, ImageEntry> {
	const images = new Map<number, ImageEntry>();
	const count = doc.countObjects();

	for (let xref = 1; xref < count; xref++) {
		let ref: MuPdfObject;
		try {
			ref = doc.newIndirect(xref);
			// `isStream` needs the indirect reference, not a resolved dictionary.
			if (!ref.isStream()) continue;
		} catch {
			continue;
		}

		try {
			// Every key is read straight off the indirect reference. `get` resolves
			// internally in C, so `resolve()` is never needed -- and must never be
			// used: see the note about it at the top of this file.
			const subtype = ref.get("Subtype");
			if (subtype.isNull() || subtype.asName() !== "Image") continue;

			const width = ref.get("Width").asNumber();
			const height = ref.get("Height").asNumber();
			if (!(width > 0) || !(height > 0)) continue;

			const stencil = ref.get("ImageMask");
			const bpcObj = ref.get("BitsPerComponent");
			const smask = ref.get("SMask");
			const lengthObj = ref.get("Length");
			const csObj = ref.get("ColorSpace");

			images.set(xref, {
				xref,
				width,
				height,
				bpc: bpcObj.isNumber() ? bpcObj.asNumber() : 8,
				isStencil: stencil.isBoolean() && stencil.asBoolean(),
				colorSpace: csObj.isName() ? csObj.asName() : csObj.isNull() ? "(none)" : "(indirect)",
				streamBytes: lengthObj.isNumber() ? lengthObj.asNumber() : 0,
				smaskXref: smask.isIndirect() ? smask.asIndirect() : null,
			});
		} catch {
			// Malformed object: not a candidate, leave it exactly as it is.
			continue;
		}
	}
	return images;
}

/**
 * Finds the largest rect each image is actually drawn at.
 *
 * mupdf caches one `fz_image` per xref, so the pointer handed to the device's
 * `fillImage` is the very same pointer `loadImage` returns. That gives an exact
 * xref -> placement mapping without interpreting content streams. The cached
 * images are held alive for the whole walk so the pointers stay unique.
 */
function measurePlacements(
	mupdf: MuPdf,
	doc: MuDocument,
	images: Map<number, ImageEntry>,
): Map<number, Placement> {
	const placements = new Map<number, Placement>();
	const pointerToXref = new Map<number, number>();
	const pinned: Array<import("mupdf").Image> = [];

	for (const xref of images.keys()) {
		try {
			const image = doc.loadImage(doc.newIndirect(xref));
			pointerToXref.set(image.pointer, xref);
			pinned.push(image);
		} catch {
			// Undecodable image: it simply never gets a placement, so it is skipped.
		}
	}

	const record = (image: import("mupdf").Image, ctm: import("mupdf").Matrix): void => {
		const xref = pointerToXref.get(image.pointer);
		if (xref === undefined) return;
		// Column norms of the CTM give the on-page footprint of the unit square,
		// which is correct under rotation and shear.
		const widthPt = Math.hypot(ctm[0], ctm[1]);
		const heightPt = Math.hypot(ctm[2], ctm[3]);
		const prev = placements.get(xref);
		placements.set(xref, {
			widthPt: Math.max(prev?.widthPt ?? 0, widthPt),
			heightPt: Math.max(prev?.heightPt ?? 0, heightPt),
		});
	};

	try {
		for (let index = 0; index < doc.countPages(); index++) {
			let page: import("mupdf").PDFPage | null = null;
			let device: import("mupdf").Device | null = null;
			try {
				page = doc.loadPage(index);
				// Only image hooks are provided; mupdf's optional-call dispatch skips
				// text and path callbacks without allocating anything for them.
				device = new mupdf.Device({
					fillImage: (image, ctm) => record(image, ctm),
					fillImageMask: (image, ctm) => record(image, ctm),
					clipImageMask: (image, ctm) => record(image, ctm),
				});
				page.run(device, mupdf.Matrix.identity);
				device.close();
			} catch {
				// A page that fails to interpret leaves its images unplaced, which
				// means untouched. That is the safe direction.
			} finally {
				device?.destroy();
				page?.destroy();
			}
		}
	} finally {
		for (const image of pinned) image.destroy();
	}

	return placements;
}

/* ----------------------------------------------------------- rewrite step ---- */

interface WriteOutcome {
	written: boolean;
	bytes: number;
}

async function rewriteImage(
	mupdf: MuPdf,
	doc: MuDocument,
	entry: ImageEntry,
	decision: Decision,
	quality: number,
): Promise<WriteOutcome> {
	const ref = doc.newIndirect(entry.xref);
	const decoded = decodeImage(mupdf, doc, ref);
	// Takes ownership of the pixmap and releases the full-size plane before the
	// encoder allocates anything.
	const plane = shrink(decoded.pixmap, decision.newWidth, decision.newHeight, "srgb");

	const isGray = plane.components === 1;
	const payload = isGray
		? await deflate(firstComponent(plane))
		: await encodeJpeg(toRgba(plane), plane.width, plane.height, quality);

	// A smooth gradient or flat artwork can already be smaller as Flate at full
	// size than as anything we produce. In that case the original stays.
	if (entry.streamBytes > 0 && payload.byteLength >= entry.streamBytes) {
		return { written: false, bytes: entry.streamBytes };
	}

	writeImageStream(doc, ref, payload, {
		isGray,
		width: decision.newWidth,
		height: decision.newHeight,
		keepColorSpace: decoded.keepColorSpace,
	});
	return { written: true, bytes: payload.byteLength };
}

interface StreamShape {
	isGray: boolean;
	width: number;
	height: number;
	/**
	 * Leaves the existing /ColorSpace entry alone. Set for images whose samples
	 * are still in their original ICC space, where naming a device space would
	 * be a lie about what the bytes mean.
	 */
	keepColorSpace: boolean;
}

/** Replaces an image XObject's stream and re-states its dictionary. */
function writeImageStream(
	doc: MuDocument,
	ref: MuPdfObject,
	payload: Uint8Array,
	shape: StreamShape,
): void {
	ref.writeRawStream(payload);
	ref.put("Filter", doc.newName(shape.isGray ? "FlateDecode" : "DCTDecode"));
	ref.put("Width", shape.width);
	ref.put("Height", shape.height);
	ref.put("BitsPerComponent", 8);
	if (!shape.keepColorSpace) {
		ref.put("ColorSpace", doc.newName(shape.isGray ? "DeviceGray" : "DeviceRGB"));
	}
	// The decoded pixmap already had these applied; keeping them would apply twice.
	ref.delete("DecodeParms");
	ref.delete("Decode");
	ref.delete("ColorKey");
	// An /Interpolate hint is meaningless once the image is at display density.
	ref.delete("Interpolate");
}

interface MaskResult {
	outcome: "opaque" | "resampled" | "bilevel" | "grew";
	bytes: number;
}

async function processSoftMask(
	mupdf: MuPdf,
	doc: MuDocument,
	mask: ImageEntry,
	targetWidth: number,
	targetHeight: number,
): Promise<MaskResult> {
	const ref = doc.newIndirect(mask.xref);
	const pixmap = decodeImage(mupdf, doc, ref).pixmap;

	// The opacity probe runs on the pixmap, while it is still the only copy: for
	// the common case of a mask that masks nothing, this answers the question
	// without ever allocating a plane for it.
	let opacity: number;
	try {
		opacity = minChannelValue(pixmap);
	} catch (error) {
		pixmap.destroy();
		throw error;
	}

	if (opacity >= SMASK_OPAQUE_THRESHOLD) {
		pixmap.destroy();
		return { outcome: "opaque", bytes: 0 };
	}
	// A 1-bit mask is already about as small as it gets; expanding it to 8-bit
	// gray to resample it would make it bigger, not smaller.
	if (mask.isStencil || mask.bpc === 1) {
		pixmap.destroy();
		return { outcome: "bilevel", bytes: mask.streamBytes };
	}

	// Masks resample with a linear transfer, not sRGB: an /SMask sample is a
	// coverage fraction, so a gamma round-trip would distort exactly the soft
	// edges the mask exists to produce. They also stay lossless, because JPEG
	// ringing on an alpha channel shows up as a halo along every one of them.
	const plane = shrink(pixmap, targetWidth, targetHeight, "linear");
	const payload = await deflate(firstComponent(plane));

	if (mask.streamBytes > 0 && payload.byteLength >= mask.streamBytes) {
		return { outcome: "grew", bytes: mask.streamBytes };
	}

	writeImageStream(doc, ref, payload, {
		isGray: true,
		width: targetWidth,
		height: targetHeight,
		// A mask is a single linear coverage channel; /DeviceGray is what it is.
		keepColorSpace: false,
	});
	return { outcome: "resampled", bytes: payload.byteLength };
}

/* ---------------------------------------------------------------- pixels ---- */

interface Decoded {
	pixmap: MuPixmap;
	/** See `StreamShape.keepColorSpace`. */
	keepColorSpace: boolean;
}

/**
 * Decodes an image XObject to a pixmap this pipeline can describe honestly in a
 * PDF dictionary: either a device space, or the image's own ICC space with its
 * /ColorSpace entry left in place. The caller owns the pixmap.
 */
function decodeImage(mupdf: MuPdf, doc: MuDocument, ref: MuPdfObject): Decoded {
	const image = doc.loadImage(ref);
	let pixmap: MuPixmap | null = null;
	try {
		pixmap = image.toPixmap();
		const components = pixmap.getNumberOfComponents();
		const csType = pixmap.getColorSpace()?.getType() ?? "None";

		if (csType === "Gray" || csType === "RGB") {
			// Either a device space, in which case naming it below is accurate and
			// free, or an ICC space that the entry already describes exactly. The
			// entry is what decides, not the pixmap: an /Indexed image whose base
			// is ICCBased also decodes to an RGB pixmap, but its entry describes a
			// palette that the expanded samples no longer match.
			if (hasReusableIccEntry(ref, components)) {
				const result = pixmap;
				pixmap = null;
				return { pixmap: result, keepColorSpace: true };
			}
			if (isDeviceEntry(ref)) {
				const result = pixmap;
				pixmap = null;
				return { pixmap: result, keepColorSpace: false };
			}
		}

		// Anything left over -- CMYK, Lab, Separation, Indexed, BGR, or an ICC
		// space the dictionary cannot restate -- is converted, so that the device
		// space written afterwards is the truth about the samples.
		const target = components === 1 ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB;
		const converted = pixmap.convertToColorSpace(target, false);
		pixmap.destroy();
		pixmap = converted;

		const result = pixmap;
		pixmap = null;
		return { pixmap: result, keepColorSpace: false };
	} catch (error) {
		pixmap?.destroy();
		throw error;
	} finally {
		image.destroy();
	}
}

/**
 * True when /ColorSpace is `[/ICCBased <stream>]` describing exactly the number
 * of components the decoded samples have, so the entry can be carried over
 * unchanged. Keeping it is what preserves an Adobe RGB or ProPhoto photograph
 * instead of reinterpreting it as sRGB.
 */
function hasReusableIccEntry(ref: MuPdfObject, components: number): boolean {
	try {
		const entry = ref.get("ColorSpace");
		if (!entry.isArray()) return false;
		const family = entry.get(0);
		if (!family.isName() || family.asName() !== "ICCBased") return false;
		const n = entry.get(1).get("N");
		return n.isNumber() && n.asNumber() === components;
	} catch {
		return false;
	}
}

/** True when /ColorSpace names a device space, whose samples need no transform. */
function isDeviceEntry(ref: MuPdfObject): boolean {
	try {
		const entry = ref.get("ColorSpace");
		if (!entry.isName()) return false;
		const name = entry.asName();
		return name === "DeviceRGB" || name === "DeviceGray" || name === "G" || name === "RGB";
	} catch {
		return false;
	}
}

/**
 * Copies a pixmap out of the WASM heap into a packed plane, shrinks it, and
 * destroys the pixmap. The full-size plane is local to this function so it can
 * be collected before the encoder runs: only one large buffer is ever live.
 */
function shrink(
	pixmap: MuPixmap,
	targetWidth: number,
	targetHeight: number,
	transfer: Transfer,
): Plane {
	const full = pixmapToPlane(pixmap);
	return resampleArea(full, targetWidth, targetHeight, transfer);
}

/** Packs a pixmap's samples, dropping mupdf's row padding, then destroys it. */
function pixmapToPlane(pixmap: MuPixmap): Plane {
	try {
		const width = pixmap.getWidth();
		const height = pixmap.getHeight();
		const components = pixmap.getNumberOfComponents();
		const stride = pixmap.getStride();
		const rowBytes = width * components;

		// A view into the WASM heap: copy it before anything can grow the heap.
		const samples = pixmap.getPixels();
		const data = new Uint8Array(rowBytes * height);
		if (stride === rowBytes) {
			data.set(samples.subarray(0, data.length));
		} else {
			for (let y = 0; y < height; y++) {
				const from = y * stride;
				data.set(samples.subarray(from, from + rowBytes), y * rowBytes);
			}
		}

		return { data, width, height, components };
	} finally {
		pixmap.destroy();
	}
}

/**
 * Cheapest possible verdict on a mask: decode it, read its darkest sample, throw
 * it away. Used for masks whose parent keeps its resolution, where the only
 * question worth asking is whether the mask does anything at all.
 */
function isMaskFullyOpaque(mupdf: MuPdf, doc: MuDocument, mask: ImageEntry): boolean {
	if (mask.isStencil) return false;
	const pixmap = decodeImage(mupdf, doc, doc.newIndirect(mask.xref)).pixmap;
	try {
		return minChannelValue(pixmap) >= SMASK_OPAQUE_THRESHOLD;
	} finally {
		pixmap.destroy();
	}
}

/** Darkest sample of the first channel. For a soft mask, that is its opacity. */
function minChannelValue(pixmap: MuPixmap): number {
	const width = pixmap.getWidth();
	const height = pixmap.getHeight();
	const components = pixmap.getNumberOfComponents();
	const stride = pixmap.getStride();
	// A view into the WASM heap: read it now, do not allocate while holding it.
	const samples = pixmap.getPixels();

	let min = 255;
	for (let y = 0; y < height; y++) {
		let src = y * stride;
		for (let x = 0; x < width; x++) {
			if (samples[src] < min) {
				min = samples[src];
				if (min === 0) return 0;
			}
			src += components;
		}
	}
	return min;
}

/**
 * zlib-wrapped deflate, which is precisely the /FlateDecode encoding. Doing it
 * here rather than at save time is what makes the byte counts in the report and
 * the per-object "did this help?" check possible.
 */
async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([bytes as unknown as BlobPart])
		.stream()
		.pipeThrough(new CompressionStream("deflate"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ----------------------------------------------------------------- utils ---- */

function blankReport(entry: ImageEntry): ObjectReport {
	const outcome: ObjectOutcome = "recompressed";
	return {
		xref: entry.xref,
		outcome,
		sourceBytes: entry.streamBytes,
		resultBytes: entry.streamBytes,
		pixelWidth: entry.width,
		pixelHeight: entry.height,
		newPixelWidth: entry.width,
		newPixelHeight: entry.height,
		effectivePpi: 0,
		colorSpace: entry.colorSpace,
		smaskDropped: false,
	};
}

export function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return "error desconocido";
}
