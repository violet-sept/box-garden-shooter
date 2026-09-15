/**
 * Types for `tools/desktop-acceptance.mjs`.
 *
 * Only the pieces the test suite imports are declared: the pure classification and
 * measurement helpers that decide whether a release run is green. Those are exactly
 * the parts that cannot be exercised by launching Electron in a locked-down shell,
 * so they are the parts worth unit-testing.
 */

import type { ImageStats } from './lib/png.mjs';

export interface ScreenshotMeasurement extends ImageStats {
  ok: true;
  /** Statistics of the HUD-free band, where only the 3D scene can contribute. */
  sceneBand: ImageStats;
}

export interface ScreenshotMeasurementFailure {
  ok: false;
  reason: string;
}

/** Lower bound on luma spread for "something was drawn". */
export const MIN_SPREAD: number;

/** The veil's call to action as written in the markup, before any script runs. */
export const STATIC_BOOT_CTA: string;

/** True once the veil no longer shows the static placeholder, i.e. the module booted. */
export function bootScriptRan(ctaText: unknown): boolean;

/** Fractions of the frame that no HUD element occupies. */
export const SCENE_BAND: { x0: number; y0: number; x1: number; y1: number };

export function isOptionalAssetUrl(url: string): boolean;

export function isOptionalAssetLogEntry(entry: { url?: string; text?: string }): boolean;

export function measureScreenshot(png: Uint8Array): ScreenshotMeasurement | ScreenshotMeasurementFailure;

export function hasAppPayload(exePath: string): boolean;
