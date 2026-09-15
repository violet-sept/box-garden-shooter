/**
 * Types for `tools/lib/png.mjs`.
 *
 * The tool scripts are plain ESM with no build step, but `tsconfig.json` includes
 * `tests/`, so anything a test imports has to be typed or `npm run typecheck`
 * fails on an implicit `any`. Hand-written declarations are the cheaper of the two
 * options (the alternative is turning the tools into TypeScript and giving them a
 * compile step they do not need).
 *
 * Inputs are `Uint8Array` rather than `Buffer` so that the declarations do not
 * depend on `@types/node` being resolvable for the tool directory.
 */

export interface ImageStats {
  width: number;
  height: number;
  pixels: number;
  mean: number;
  min: number;
  max: number;
  spread: number;
  opaqueFraction: number;
}

export interface RgbaImage {
  rgba: Uint8Array;
  width: number;
  height: number;
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array;

export function decodePng(buffer: Uint8Array): RgbaImage;

export function imageStats(rgba: Uint8Array, width: number, height: number): ImageStats;

export function statsOfPng(buffer: Uint8Array): ImageStats;

export function cropRgba(
  rgba: Uint8Array,
  width: number,
  height: number,
  x0Fraction: number,
  y0Fraction: number,
  x1Fraction: number,
  y1Fraction: number,
): RgbaImage;
