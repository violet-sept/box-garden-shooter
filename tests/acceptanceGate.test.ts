/**
 * Tests for the release acceptance gate's pure logic.
 *
 * `tools/desktop-acceptance.mjs` decides whether a packaged build is shippable, and
 * it is also the one part of the delivery path that cannot be run here: the machine's
 * sandbox refuses every Chromium process (technical plan section 5.3.1), so the gate
 * has to be trustworthy by construction rather than by having been watched.
 *
 * Two of its checks were provably broken and are pinned here:
 *
 *   1. the picture check drew the WebGL canvas into a 2D scratch canvas and read the
 *      pixels back. The renderer runs with `preserveDrawingBuffer: false`, so the
 *      drawing buffer is cleared before anything reads it: a run whose screenshot
 *      plainly showed the arena still measured `spread 0` and failed. The gate now
 *      measures the composited screenshot instead.
 *   2. the log-error check was unfiltered, so the optional (not-yet-delivered)
 *      character model failed the gate through Chromium's `Log` channel even though
 *      decision D12 had whitelisted it on the `Network` channel.
 *
 * The "HUD-only frame" case below is the one that keeps the picture check honest: it
 * is a frame that passes the whole-frame threshold *and* must fail the scene-band one.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { cropRgba, decodePng, encodePng, imageStats } from '../tools/lib/png.mjs';
import {
  MIN_SPREAD,
  SCENE_BAND,
  STATIC_BOOT_CTA,
  bootScriptRan,
  hasAppPayload,
  isOptionalAssetLogEntry,
  isOptionalAssetUrl,
  measureScreenshot,
} from '../tools/desktop-acceptance.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Scratch area for the one filesystem-shaped helper. Gitignored via `.tmp-*`. */
const FIXTURE_ROOT = path.join(ROOT, '.tmp-tests');

afterAll(() => {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

/** 8-bit RGBA buffer of `size` x `size`, painted by a per-pixel function. */
function paint(size: number, colorAt: (x: number, y: number) => [number, number, number]): Uint8Array {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = colorAt(x, y);
      const i = (y * size + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

const FLAT_FRAME = paint(240, () => [18, 22, 30]);

/** Stands in for a rendered arena: broad luma range everywhere. */
const SCENE_FRAME = paint(240, (x, y) => {
  const value = (x * 3 + y * 5) % 256;
  return [value, (value * 2) % 256, 255 - value];
});

/**
 * A frame whose top 60% is a flat clear and whose bottom 40% is high-contrast HUD
 * chrome. The whole-frame threshold is met; the scene band is not.
 */
const HUD_ONLY_FRAME = paint(240, (_x, y) =>
  y < 144 ? [12, 14, 20] : _x % 20 < 10 ? [255, 255, 255] : [0, 0, 0],
);

describe('screenshot measurement (the picture check)', () => {
  it('round-trips pixels through the PNG codec', () => {
    const encoded = encodePng(240, 240, SCENE_FRAME);
    const decoded = decodePng(encoded);
    expect(decoded.width).toBe(240);
    expect(decoded.height).toBe(240);
    expect(Array.from(decoded.rgba.subarray(0, 8))).toEqual(Array.from(SCENE_FRAME.subarray(0, 8)));
    expect(imageStats(decoded.rgba, decoded.width, decoded.height)).toEqual(
      imageStats(SCENE_FRAME, 240, 240),
    );
  });

  it('reports a blank frame as flat, which is what the gate must reject', () => {
    const measured = measureScreenshot(encodePng(240, 240, FLAT_FRAME));
    expect(measured.ok).toBe(true);
    if (!measured.ok) return;
    expect(measured.spread).toBe(0);
    expect(measured.spread).toBeLessThanOrEqual(MIN_SPREAD);
    // The exact shape of the old false positive: a cleared drawing buffer reads back
    // as transparent zeroes, so alphas are 0 and the frame looks "empty".
    expect(measured.opaqueFraction).toBe(1);
  });

  it('accepts a drawn scene in both the whole frame and the scene band', () => {
    const measured = measureScreenshot(encodePng(240, 240, SCENE_FRAME));
    expect(measured.ok).toBe(true);
    if (!measured.ok) return;
    expect(measured.spread).toBeGreaterThan(MIN_SPREAD);
    expect(measured.sceneBand.spread).toBeGreaterThan(MIN_SPREAD);
  });

  it('separates "the HUD drew" from "the 3D scene drew"', () => {
    const measured = measureScreenshot(encodePng(240, 240, HUD_ONLY_FRAME));
    expect(measured.ok).toBe(true);
    if (!measured.ok) return;
    // The whole frame looks alive, so the old single-threshold check would pass...
    expect(measured.spread).toBeGreaterThan(MIN_SPREAD);
    // ...while the HUD-free band is flat, which is the case it must catch.
    expect(measured.sceneBand.spread).toBe(0);
    expect(measured.sceneBand.spread).toBeLessThanOrEqual(MIN_SPREAD);
    // The band has to sit inside the top of the frame for that to hold.
    expect(SCENE_BAND.y1).toBeLessThanOrEqual(0.6);
    expect(SCENE_BAND.x0).toBeGreaterThanOrEqual(0);
    expect(SCENE_BAND.x1).toBeLessThanOrEqual(1);
  });

  it('reports undecodable input as data instead of throwing', () => {
    const measured = measureScreenshot(Buffer.from('this is not a png'));
    expect(measured.ok).toBe(false);
    if (measured.ok) return;
    expect(measured.reason).toContain('PNG');
  });

  it('clamps crops to the frame instead of reading out of bounds', () => {
    const cropped = cropRgba(SCENE_FRAME, 240, 240, -1, -1, 2, 2);
    expect(cropped.width).toBe(240);
    expect(cropped.height).toBe(240);
    const inverted = cropRgba(SCENE_FRAME, 240, 240, 0.8, 0.8, 0.2, 0.2);
    expect(inverted.width).toBe(1);
    expect(inverted.height).toBe(1);
  });
});

describe('the optional-asset exemption is bounded on both channels', () => {
  it('recognises the delivered-elsewhere character model in any scheme', () => {
    expect(isOptionalAssetUrl('file:///E:/app/dist/assets/models/player/player.glb')).toBe(true);
    expect(isOptionalAssetUrl('file:///assets/models/player/player.glb?v=2')).toBe(true);
    expect(isOptionalAssetUrl('http://localhost:4173/assets/models/player/player.glb')).toBe(true);
    // Where the relative URL from CharacterLoader actually lands once a host has
    // resolved it: under `dist/` in the package, and under the repo on a Pages
    // project site. Both are still the same optional asset, by suffix.
    expect(isOptionalAssetUrl('https://user.github.io/box-garden-shooter/assets/models/player/player.glb')).toBe(
      true,
    );
  });

  it('does not exempt anything else', () => {
    expect(isOptionalAssetUrl('https://cdn.example.com/three@0.186/three.module.js')).toBe(false);
    expect(isOptionalAssetUrl('file:///E:/app/dist/assets/index-BH6fuerk.js')).toBe(false);
    // A near miss must not be treated as the asset.
    expect(isOptionalAssetUrl('file:///assets/models/player/player.glb.bak')).toBe(false);
    expect(isOptionalAssetUrl('')).toBe(false);
  });

  it('exempts a log error only when it names the asset', () => {
    expect(
      isOptionalAssetLogEntry({ url: 'file:///assets/models/player/player.glb', text: 'Failed to load resource' }),
    ).toBe(true);
    expect(
      isOptionalAssetLogEntry({ url: '', text: 'Failed to fetch /assets/models/player/player.glb' }),
    ).toBe(true);
    // The shape Chromium emitted for the real failure before the URL was recorded.
    // With no URL and no asset name it stays a *required* error, i.e. the gate says
    // FAIL and prints the entry rather than quietly passing.
    expect(
      isOptionalAssetLogEntry({ url: '', text: 'Failed to load resource: net::ERR_FILE_NOT_FOUND' }),
    ).toBe(false);
    expect(isOptionalAssetLogEntry({ url: 'https://cdn.example.com/three.module.js', text: 'nope' })).toBe(false);
    expect(isOptionalAssetLogEntry({})).toBe(false);
  });
});

describe('packaged artifact completeness', () => {
  it('tells an interrupted build apart from a real package', () => {
    const interrupted = path.join(FIXTURE_ROOT, 'interrupted');
    const complete = path.join(FIXTURE_ROOT, 'complete');
    const unpacked = path.join(FIXTURE_ROOT, 'unpacked');
    mkdirSync(path.join(interrupted, 'resources'), { recursive: true });
    mkdirSync(path.join(complete, 'resources'), { recursive: true });
    mkdirSync(path.join(unpacked, 'resources', 'app'), { recursive: true });
    // A bare Electron copy: this is what electron-builder leaves behind when it
    // dies in its node-module collector, and it is not the app.
    writeFileSync(path.join(interrupted, 'resources', 'default_app.asar'), '');
    writeFileSync(path.join(interrupted, 'electron.exe'), '');
    writeFileSync(path.join(complete, 'resources', 'app.asar'), '');
    writeFileSync(path.join(complete, 'box-garden-shooter.exe'), '');
    writeFileSync(path.join(unpacked, 'resources', 'app', 'package.json'), '{}');

    expect(hasAppPayload(path.join(interrupted, 'electron.exe'))).toBe(false);
    expect(hasAppPayload(path.join(complete, 'box-garden-shooter.exe'))).toBe(true);
    expect(hasAppPayload(path.join(unpacked, 'box-garden-shooter.exe'))).toBe(true);
    expect(hasAppPayload(path.join(FIXTURE_ROOT, 'missing', 'app.exe'))).toBe(false);
  });
});

describe('did the boot script run', () => {
  it('fails while the veil still shows the static placeholder', () => {
    // This is the state every other assertion in the gate is happy with: the DOM is
    // intact, WebGL is available, the veil is up and the HUD is hidden. A page whose
    // script never ran looks exactly like this and ignores every click (plan §5.13).
    expect(bootScriptRan(STATIC_BOOT_CTA)).toBe(false);
    expect(bootScriptRan(`  ${STATIC_BOOT_CTA}  `)).toBe(false);
  });

  it('passes once the module has replaced it', () => {
    // What `showVeil` actually writes into `#boot-cta`: the title and the detail, as
    // nested elements, concatenated by `textContent`.
    expect(bootScriptRan('箱庭射击点击画面开始 · Esc 释放鼠标')).toBe(true);
    expect(bootScriptRan('已暂停点击画面返回游戏 · Esc 释放鼠标')).toBe(true);
    expect(bootScriptRan('胜利8 波全部清空 · 用时 9:12')).toBe(true);
  });

  it('fails closed on a probe that returned nothing', () => {
    // A missing element, a dead page or a changed id must never read as "it booted".
    expect(bootScriptRan(undefined)).toBe(false);
    expect(bootScriptRan(null)).toBe(false);
    expect(bootScriptRan('')).toBe(false);
    expect(bootScriptRan('   ')).toBe(false);
    expect(bootScriptRan(42)).toBe(false);
  });
});
