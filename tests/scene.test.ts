/**
 * Scene rig tests (phase 4).
 *
 * These exist for one specific defect class: **a knob that looks adjustable and
 * changes nothing**. The stage-4 reading list found exactly that in `RENDER` —
 * `fogNear` / `fogFar` were listed in the tuning table and shown in the code, but the
 * scene builds an exponential fog whose *density* is what matters, and the density
 * was a literal in `sceneRig.ts`. Tuning the fog therefore meant editing code, and
 * editing the documented fields did nothing at all.
 *
 * So the assertions here are about provenance rather than about appearance: the
 * density, the shadow extent and the shadow map size must all *come from the tuning
 * table*, and changing the table must change the scene. Nothing here can say whether
 * the fog looks right — that is a picture, and no test can take one.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { DirectionalLight, FogExp2, PerspectiveCamera, Scene } from 'three';
import { createSceneRig, syncCameraProjection } from '#/render/scene/sceneRig';
import { RENDER, RENDER_TUNING, SIM } from '#/core/config';

/** The arena span the fog density is expressed relative to. */
const ARENA_SPAN = SIM.arenaHalfSize * 2;

/** Restores any tuning value a test wrote through the mutable alias. */
const restore: (() => void)[] = [];
afterEach(() => {
  while (restore.length > 0) restore.pop()?.();
});

/** Writes a tuning value and registers its restoration. */
function tune<K extends keyof typeof RENDER_TUNING>(key: K, value: number): void {
  const previous = RENDER_TUNING[key];
  restore.push(() => {
    RENDER_TUNING[key] = previous;
  });
  RENDER_TUNING[key] = value;
}

describe('scene rig', () => {
  it('derives the fog density from the tuning table', () => {
    const scene = new Scene();
    createSceneRig(scene);
    const fog = scene.fog;
    expect(fog).toBeInstanceOf(FogExp2);
    expect((fog as FogExp2).density).toBeCloseTo(RENDER.fogDensityPerArenaSpan / ARENA_SPAN, 9);
    expect((fog as FogExp2).color.getHex()).toBe(RENDER.fogColor);
  });

  it('changes the fog when the density is retuned', () => {
    const before = new Scene();
    createSceneRig(before);
    const baseline = (before.fog as FogExp2).density;

    // The dead-field failure in one assertion: if the density were a literal, this
    // write would leave the scene unchanged and the check below would fail.
    tune('fogDensityPerArenaSpan', RENDER_TUNING.fogDensityPerArenaSpan * 2.5);
    const after = new Scene();
    createSceneRig(after);
    const retuned = (after.fog as FogExp2).density;

    expect(retuned).toBeGreaterThan(baseline);
    expect(retuned / baseline).toBeCloseTo(2.5, 6);
  });

  it('derives both shadow knobs from the tuning table', () => {
    const scene = new Scene();
    createSceneRig(scene);
    const casters = scene.children.filter(
      (child) => (child as DirectionalLight).isDirectionalLight && (child as DirectionalLight).castShadow,
    );
    // One shadow caster is the phase-0 budget: a second doubles the cost of the
    // shadow pass for very little of the box-garden read.
    expect(casters.length).toBe(1);

    const key = casters[0] as DirectionalLight;
    expect(key.shadow.mapSize.width).toBe(RENDER.shadowMapSize);
    expect(key.shadow.mapSize.height).toBe(RENDER.shadowMapSize);
    expect(key.shadow.camera.right).toBe(RENDER.shadowExtent);
    expect(key.shadow.camera.left).toBe(-RENDER.shadowExtent);

    // ... and the extent really is read at construction time.
    tune('shadowExtent', RENDER_TUNING.shadowExtent / 2);
    const smaller = new Scene();
    createSceneRig(smaller);
    const retuned = smaller.children.find(
      (child) => (child as DirectionalLight).isDirectionalLight && (child as DirectionalLight).castShadow,
    ) as DirectionalLight;
    expect(retuned.shadow.camera.right).toBe(RENDER_TUNING.shadowExtent);
  });

  it('follows a target without changing the light direction', () => {
    const scene = new Scene();
    const rig = createSceneRig(scene);
    rig.follow({ x: 0, y: 0, z: 0 });
    const key = scene.children.find(
      (child) => (child as DirectionalLight).isDirectionalLight && (child as DirectionalLight).castShadow,
    ) as DirectionalLight;
    const offset = key.position.clone().sub(key.target.position);

    rig.follow({ x: 12, y: 0, z: -7 });
    const moved = key.position.clone().sub(key.target.position);
    expect(moved.x).toBeCloseTo(offset.x, 9);
    expect(moved.y).toBeCloseTo(offset.y, 9);
    expect(moved.z).toBeCloseTo(offset.z, 9);
    expect(key.target.position.x).toBeCloseTo(12, 9);
  });

  it('keeps the far plane past the whole arena', () => {
    const camera = new PerspectiveCamera(78, 1, 0.1, 10);
    syncCameraProjection(camera, 1600, 900);
    expect(camera.aspect).toBeCloseTo(1600 / 900, 9);
    // The fog has to be what ends the view, not the near/far planes: a far plane
    // inside the arena clips the fence into a hard black edge.
    expect(camera.far).toBeGreaterThanOrEqual(ARENA_SPAN * 3);
    expect(camera.far).toBeGreaterThanOrEqual(RENDER.cameraFar);
    // The near plane stays small so the weapon and the shoulder camera do not clip.
    expect(camera.near).toBeLessThan(0.5);
  });

  it('survives a degenerate viewport', () => {
    const camera = new PerspectiveCamera(78, 1, 0.1, 10);
    syncCameraProjection(camera, 800, 0);
    expect(Number.isFinite(camera.aspect)).toBe(true);
    expect(camera.aspect).toBeGreaterThan(0);
    expect(Number.isFinite(camera.far)).toBe(true);
  });
});
