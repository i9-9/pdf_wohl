/**
 * JPEG encoding through mozjpeg (WASM), not the browser's encoder.
 *
 * `OffscreenCanvas.convertToBlob({ type: "image/jpeg" })` gives no control over
 * chroma subsampling, and browsers subsample 4:2:0 at ordinary qualities: the
 * colour channels are stored at half resolution on both axes, so an image
 * downsampled to 110 ppi carries its colour at 55 ppi. Chroma error dominates
 * total error in every measurement taken here -- typically 75% to 95% of it --
 * so that halving is the single biggest colour cost in the pipeline, and the
 * platform API cannot address it.
 *
 * mozjpeg also brings better quantisation tables, which measure more accurate
 * than the JPEG Annex K tables a plain libjpeg build uses. That is what pays for
 * most of the cost of 4:4:4.
 */

/** Subset of mozjpeg's options that this app sets. */
interface MozJpegOptions {
	quality: number;
	baseline: boolean;
	arithmetic: boolean;
	progressive: boolean;
	optimize_coding: boolean;
	smoothing: number;
	color_space: number;
	quant_table: number;
	trellis_multipass: boolean;
	trellis_opt_zero: boolean;
	trellis_opt_table: boolean;
	trellis_loops: number;
	auto_subsample: boolean;
	chroma_subsample: number;
	separate_chroma_quality: boolean;
	chroma_quality: number;
}

interface MozJpegModule {
	encode(data: Uint8Array, width: number, height: number, options: MozJpegOptions): Uint8Array;
}

type MozJpegFactory = (options: { noInitialRun: boolean }) => Promise<MozJpegModule>;

export const DEFAULT_ENCODER_URL = "/mozjpeg/mozjpeg_enc.js";

let encoderPromise: Promise<MozJpegModule> | null = null;

/**
 * Loads mozjpeg from /public rather than bundling it, for the same reason mupdf
 * is loaded that way: the emscripten glue resolves its .wasm relative to its own
 * URL, which a bundler would rewrite.
 */
export function loadEncoder(url: string = DEFAULT_ENCODER_URL): Promise<MozJpegModule> {
	if (!encoderPromise) {
		encoderPromise = import(/* webpackIgnore: true */ url).then((module) => {
			const factory = (module as { default: MozJpegFactory }).default;
			return factory({ noInitialRun: true });
		});
	}
	return encoderPromise;
}

/** mozjpeg's colour space enum: 1 grayscale, 2 RGB, 3 YCbCr. */
const YCBCR = 3;

/**
 * Everything except `quality` is fixed, and every value was chosen by
 * measurement rather than taste:
 *
 * - `chroma_subsample: 1` with `auto_subsample: false` is full 4:4:4 chroma.
 *   This is the point of using mozjpeg at all.
 * - `quant_table: 3`, the tables Squoosh defaults to, against the JPEG Annex K
 *   tables of a plain libjpeg build: dE 1.050 -> 0.977 on a product shot at
 *   q78, for 3.5% more bytes. The best value per byte in this list.
 * - Trellis quantisation is deliberately *off*. It is mozjpeg's headline
 *   feature and it did nothing here: dE 0.977 without it against 0.993 with a
 *   single loop, and file sizes within 0.1%, while costing 30% to 140% more
 *   encode time. Paying twice the time for no measurable gain on the content
 *   this app processes is not a trade worth making.
 * - `progressive: false`. Progressive JPEG saves a few percent and is legal
 *   inside DCTDecode, but sequential is what every viewer and every print RIP
 *   handles without argument. A catalogue that fails at the printer is not
 *   worth 3%.
 * - `optimize_coding: true` computes Huffman tables from the actual data. It is
 *   a lossless win and costs almost nothing.
 * - `smoothing: 0`. Pre-blurring would fight the resampler, which is already
 *   applying the correct low-pass.
 */
const FIXED: Omit<MozJpegOptions, "quality" | "chroma_quality"> = {
	baseline: false,
	arithmetic: false,
	progressive: false,
	optimize_coding: true,
	smoothing: 0,
	color_space: YCBCR,
	quant_table: 3,
	trellis_multipass: false,
	trellis_opt_zero: false,
	trellis_opt_table: false,
	trellis_loops: 1,
	auto_subsample: false,
	chroma_subsample: 1,
	separate_chroma_quality: false,
};

/** Encodes RGBA samples as a sequential 4:4:4 JPEG. */
export async function encodeJpeg(
	rgba: Uint8Array,
	width: number,
	height: number,
	quality: number,
): Promise<Uint8Array> {
	const encoder = await loadEncoder();
	const encoded = encoder.encode(rgba, width, height, {
		...FIXED,
		quality,
		chroma_quality: quality,
	});
	// The result is a view into the WASM heap, exactly like mupdf's buffers: copy
	// it out before anything else can grow and detach it.
	return encoded.slice();
}
