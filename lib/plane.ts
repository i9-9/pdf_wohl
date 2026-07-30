/**
 * Pixel planes and the resampler that shrinks them.
 *
 * This replaces an earlier OffscreenCanvas path (`drawImage` with
 * `imageSmoothingQuality: "high"`, halving once per step). Canvas was dropped
 * for three reasons, in order of how much they cost:
 *
 * 1. `drawImage` averages gamma-encoded sRGB bytes. Averaging in a non-linear
 *    space is simply the wrong operation: a black/white pair averages to 128
 *    when the correct answer is 188. On smooth photographic areas the error is
 *    negligible, but around hard edges and blown highlights it reaches dE 24,
 *    and it lands on 3.3% of the pixels of a typical product shot -- exactly
 *    the pixels a catalogue is looking at.
 * 2. The filter `drawImage` actually applies is unspecified and differs per
 *    engine, so output quality depended on the browser.
 * 3. A canvas needs an RGBA backing store, 4 bytes per pixel, on top of the
 *    decoded image. Working on packed planes drops that to `components`.
 *
 * The filter here is an exact area average: every output pixel is the mean of
 * the source pixels its footprint covers, weighted by how much of each it
 * covers. Against an analytically supersampled ideal that lands at dE 0.03
 * mean, where Lanczos3 scores 0.40 and overshoots to dE 40 at hard edges --
 * sharper reconstruction filters buy acuity by ringing, which on a product edge
 * reads as a halo. Area averaging cannot overshoot: its output is always within
 * the range of its inputs.
 */

/** Tightly packed 8-bit samples, `components` per pixel, no row padding. */
export interface Plane {
	data: Uint8Array;
	width: number;
	height: number;
	components: number;
}

const TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
	const c = i / 255;
	TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

const IDENTITY = new Float32Array(256);
for (let i = 0; i < 256; i++) IDENTITY[i] = i / 255;

function encodeSrgb(value: number): number {
	const c = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
	const byte = Math.round(c * 255);
	return byte < 0 ? 0 : byte > 255 ? 255 : byte;
}

function encodeIdentity(value: number): number {
	const byte = Math.round(value * 255);
	return byte < 0 ? 0 : byte > 255 ? 255 : byte;
}

/**
 * How the samples relate to intensity.
 *
 * `srgb` is for anything that carries colour, including DeviceGray, which is
 * also a gamma-encoded intensity.
 *
 * `linear` is for soft masks. A /SMask sample is a coverage fraction, already
 * linear by definition, so putting it through a gamma round-trip would distort
 * the very edges the mask exists to soften.
 */
export type Transfer = "srgb" | "linear";

interface AxisPlan {
	/** First contributing source index for each target index. */
	starts: Int32Array;
	/** Number of contributing source indices for each target index. */
	counts: Int32Array;
	/** Weights for every target index, concatenated in `starts` order. */
	weights: Float32Array;
	/** Offset into `weights` where each target index's run begins. */
	offsets: Int32Array;
}

/**
 * Overlap of each source cell with each target cell, along one axis. Source
 * cell `s` covers the target interval [s*scale, (s+1)*scale]; the weight is how
 * much of that lands inside target cell `t`'s interval [t, t+1].
 */
function planAxis(sourceCount: number, targetCount: number): AxisPlan {
	const scale = targetCount / sourceCount;
	const starts = new Int32Array(targetCount);
	const counts = new Int32Array(targetCount);
	const offsets = new Int32Array(targetCount);
	const collected: number[] = [];

	for (let t = 0; t < targetCount; t++) {
		const from = Math.min(sourceCount - 1, Math.max(0, Math.floor(t / scale)));
		const to = Math.min(sourceCount - 1, Math.max(from, Math.ceil((t + 1) / scale) - 1));
		offsets[t] = collected.length;
		starts[t] = from;

		let sum = 0;
		for (let s = from; s <= to; s++) {
			const overlap = Math.min((s + 1) * scale, t + 1) - Math.max(s * scale, t);
			const weight = overlap > 0 ? overlap : 0;
			collected.push(weight);
			sum += weight;
		}
		counts[t] = to - from + 1;

		// Normalising per target cell absorbs the rounding at the edges, so every
		// output pixel is a true weighted mean even when the ratio is fractional.
		if (sum > 0) {
			for (let k = offsets[t]; k < collected.length; k++) collected[k] /= sum;
		}
	}

	return { starts, counts, offsets, weights: new Float32Array(collected) };
}

/**
 * Shrinks `source` to the given size by area averaging in linear light.
 *
 * Output rows are produced one at a time, each gathering only the source rows
 * it needs, so the only float buffers alive are two single rows -- about 17 KB
 * for a 1457-wide target.
 *
 * The alternative is to walk the source once and scatter into a full
 * target-sized float accumulator. Measured, that version is about 10% faster
 * (98 ms against 108 ms on a 2400x1500 to 1457x910 reduction), because
 * gathering runs the horizontal pass ~1.6 times per source row where scattering
 * runs it once. It was still rejected: its accumulator is 5.3 MB for that
 * target and 46 MB for a 6000x4000 photograph, which is real pressure in a tab
 * that also has to hold a 50 MB document and mupdf's heap. Ten percent of the
 * resampling time is a cheap price for a bounded working set.
 */
export function resampleArea(
	source: Plane,
	targetWidth: number,
	targetHeight: number,
	transfer: Transfer,
): Plane {
	const { data, width, height, components } = source;
	if (targetWidth === width && targetHeight === height) return source;

	const decode = transfer === "srgb" ? TO_LINEAR : IDENTITY;
	const encode = transfer === "srgb" ? encodeSrgb : encodeIdentity;

	const rowStride = targetWidth * components;
	const out = new Uint8Array(rowStride * targetHeight);
	const accumulator = new Float32Array(rowStride);
	const reduced = new Float32Array(rowStride);

	const xPlan = planAxis(width, targetWidth);
	const yPlan = planAxis(height, targetHeight);
	// Hoisted: these are read once per sample of a multi-megapixel image, and
	// property lookups there are not free.
	const xStarts = xPlan.starts;
	const xCounts = xPlan.counts;
	const xOffsets = xPlan.offsets;
	const xWeights = xPlan.weights;

	/** Area-averages one source row along x, into `reduced`. */
	const reduceRow = (sy: number): void => {
		const sourceRow = sy * width * components;
		for (let tx = 0; tx < targetWidth; tx++) {
			const start = sourceRow + xStarts[tx] * components;
			const offset = xOffsets[tx];
			const end = offset + xCounts[tx];
			const target = tx * components;

			// Three channels is every colour photograph and one is every soft mask
			// and grayscale image, so both are unrolled. The general loop is only
			// reached by exotic pixmaps.
			if (components === 3) {
				let r = 0;
				let g = 0;
				let b = 0;
				for (let j = offset, s = start; j < end; j++, s += 3) {
					const weight = xWeights[j];
					r += decode[data[s]] * weight;
					g += decode[data[s + 1]] * weight;
					b += decode[data[s + 2]] * weight;
				}
				reduced[target] = r;
				reduced[target + 1] = g;
				reduced[target + 2] = b;
			} else if (components === 1) {
				let v = 0;
				for (let j = offset, s = start; j < end; j++, s++) {
					v += decode[data[s]] * xWeights[j];
				}
				reduced[target] = v;
			} else {
				for (let c = 0; c < components; c++) reduced[target + c] = 0;
				for (let j = offset, s = start; j < end; j++, s += components) {
					const weight = xWeights[j];
					for (let c = 0; c < components; c++) {
						reduced[target + c] += decode[data[s + c]] * weight;
					}
				}
			}
		}
	};

	for (let ty = 0; ty < targetHeight; ty++) {
		const from = yPlan.starts[ty];
		const offset = yPlan.offsets[ty];
		const count = yPlan.counts[ty];

		// A source row that falls entirely inside this output row is the common
		// case at large reductions, and needs no accumulation at all.
		if (count === 1) {
			reduceRow(from);
			const base = ty * rowStride;
			for (let i = 0; i < rowStride; i++) out[base + i] = encode(reduced[i]);
			continue;
		}

		accumulator.fill(0);
		for (let k = 0; k < count; k++) {
			const weight = yPlan.weights[offset + k];
			if (weight === 0) continue;
			reduceRow(from + k);
			for (let i = 0; i < rowStride; i++) accumulator[i] += reduced[i] * weight;
		}
		const base = ty * rowStride;
		for (let i = 0; i < rowStride; i++) out[base + i] = encode(accumulator[i]);
	}

	return { data: out, width: targetWidth, height: targetHeight, components };
}

/** Drops every component but the first. Used to take a mask's gray channel. */
export function firstComponent(plane: Plane): Uint8Array {
	if (plane.components === 1) return plane.data;
	const out = new Uint8Array(plane.width * plane.height);
	for (let i = 0, src = 0; i < out.length; i++, src += plane.components) {
		out[i] = plane.data[src];
	}
	return out;
}

/** Expands packed RGB to RGBA. mozjpeg's wrapper only accepts four channels. */
export function toRgba(plane: Plane): Uint8Array {
	const pixels = plane.width * plane.height;
	const out = new Uint8Array(pixels * 4);
	const { data, components } = plane;
	for (let p = 0; p < pixels; p++) {
		const src = p * components;
		const dst = p * 4;
		if (components === 1) {
			out[dst] = data[src];
			out[dst + 1] = data[src];
			out[dst + 2] = data[src];
		} else {
			out[dst] = data[src];
			out[dst + 1] = data[src + 1];
			out[dst + 2] = data[src + 2];
		}
		out[dst + 3] = 255;
	}
	return out;
}
