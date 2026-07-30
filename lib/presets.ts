import type { CompressSettings, Preset, PresetId } from "./types";

export const PRESETS: readonly Preset[] = [
	{
		id: "max",
		label: "Máxima calidad",
		hint: "200 ppi · q85 — impresión chica y zoom fuerte",
		targetPpi: 200,
		quality: 85,
	},
	{
		id: "balanced",
		label: "Equilibrado",
		hint: "150 ppi · q78 — proyección y pantalla",
		targetPpi: 150,
		quality: 78,
	},
	{
		id: "light",
		label: "Liviano",
		hint: "110 ppi · q68 — mail y revisión rápida",
		targetPpi: 110,
		quality: 68,
	},
] as const;

export const DEFAULT_PRESET_ID: PresetId = "balanced";

export const PPI_MIN = 72;
export const PPI_MAX = 300;
export const QUALITY_MIN = 50;
export const QUALITY_MAX = 95;

/**
 * Images are only rewritten when they exceed the target by this factor.
 * Re-encoding something that is already near the target only degrades it while
 * saving almost nothing, so the margin is deliberately generous.
 */
export const REENCODE_MARGIN = 1.15;

export function getPreset(id: PresetId): Preset {
	const found = PRESETS.find((p) => p.id === id);
	if (!found) throw new Error(`unknown preset: ${id}`);
	return found;
}

export function clampSettings(settings: CompressSettings): CompressSettings {
	return {
		targetPpi: Math.min(PPI_MAX, Math.max(PPI_MIN, Math.round(settings.targetPpi))),
		quality: Math.min(QUALITY_MAX, Math.max(QUALITY_MIN, Math.round(settings.quality))),
	};
}

/** Returns the preset whose knobs match exactly, or null for a custom combo. */
export function matchPreset(settings: CompressSettings): Preset | null {
	return (
		PRESETS.find(
			(p) => p.targetPpi === settings.targetPpi && p.quality === settings.quality,
		) ?? null
	);
}
