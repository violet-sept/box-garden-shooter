/**
 * Scene furniture: sky, fog and the light rig.
 *
 * The art direction note in the technical plan is "box-garden feel comes from
 * unified lighting + saturated materials + a hard boundary", and that is exactly
 * what this file encodes:
 *
 *   - A **single shadow-casting directional light**. One is the budget; a second
 *     doubles the shadow cost for very little of the box-garden read.
 *   - The shadow camera **follows the player** and covers ~60 m, rather than
 *     covering the 48 m arena plus surroundings at full resolution. That is the
 *     precondition for a 2048 map being enough.
 *   - Exponential fog **at the arena scale**, so the fence fades into the
 *     background instead of ending the world at a visible edge.
 */

import {
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  Object3D,
  PerspectiveCamera,
  Scene,
  Vector3,
} from 'three';
import { RENDER, SIM } from '../../core/config';

/** A structural point, so the simulation's plain vectors can be passed straight in. */
type PointLike = { readonly x: number; readonly y: number; readonly z: number };

/** The light rig, with the hooks needed to keep shadows around the player. */
export interface SceneRig {
  readonly scene: Scene;
  /** Re-centres the shadow camera on a point. Call once per frame. */
  follow(target: PointLike): void;
  /** Points the key light down and across the arena. */
  dispose(): void;
}

/** Applies sky, fog and lights to a scene. */
export function createSceneRig(scene: Scene): SceneRig {
  scene.background = new Color(RENDER.backgroundColor);

  // Fog is derived from the arena rather than hard-coded, so growing the play space
  // does not silently leave the far wall unfogged. `FogExp2` takes a density (1/m),
  // not a distance: the arena span is the scale at which the fence should be
  // softening rather than the point at which it disappears.
  //
  // Phase 4: this used to be a literal `1.25 / arenaSpan` while `RENDER.fogNear` /
  // `fogFar` sat in the tuning table as dead fields. The density is now the knob.
  const arenaSpan = SIM.arenaHalfSize * 2;
  scene.fog = new FogExp2(RENDER.fogColor, RENDER.fogDensityPerArenaSpan / arenaSpan);

  // --- Ambient bounce --------------------------------------------------------
  // Sky/ground hemisphere rather than a flat ambient: it gives the top faces a
  // different tint from the undersides, which is most of what makes the blocks
  // read as three-dimensional without extra lights.
  const hemi = new HemisphereLight(RENDER.hemiSkyColor, RENDER.hemiGroundColor, RENDER.hemiIntensity);
  hemi.position.set(0, 30, 0);
  scene.add(hemi);

  // --- Key light -------------------------------------------------------------
  const key = new DirectionalLight(RENDER.keyColor, RENDER.keyIntensity);
  key.position.set(26, 36, 18);
  key.castShadow = true;
  key.shadow.mapSize.set(RENDER.shadowMapSize, RENDER.shadowMapSize);

  // A tight orthographic frustum that travels with the player. `bias` and
  // `normalBias` are both set: bias alone leaves peter-panning on the thin
  // fence rails, normalBias alone leaves acne on the flat ground.
  //
  // The extent is the cost/quality knob of the shadow pass and lives in the tuning
  // table (phase 4): the map is a fixed 2048, so halving this doubles the effective
  // shadow resolution and doubling it doubles the area that has to keep detail.
  const shadowExtent = RENDER.shadowExtent;
  key.shadow.camera.left = -shadowExtent;
  key.shadow.camera.right = shadowExtent;
  key.shadow.camera.top = shadowExtent;
  key.shadow.camera.bottom = -shadowExtent;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 140;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.03;
  key.shadow.camera.updateProjectionMatrix();

  scene.add(key);
  scene.add(key.target);

  // --- Rim light -------------------------------------------------------------
  // No shadows, low intensity, opposite the key: it separates silhouettes from
  // the fog without touching the shadow budget.
  const rim = new DirectionalLight(RENDER.rimColor, RENDER.rimIntensity);
  rim.position.set(-20, 14, -24);
  scene.add(rim);

  const lightOffset = new Vector3(26, 36, 18);

  return {
    scene,
    follow(target) {
      // Moving both the light and its target by the same delta keeps the light's
      // *direction* constant while the shadow frustum tracks the player.
      key.position.set(target.x + lightOffset.x, target.y + lightOffset.y, target.z + lightOffset.z);
      key.target.position.set(target.x, target.y, target.z);
      key.target.updateMatrixWorld();
      key.updateMatrixWorld();
    },
    dispose() {
      scene.remove(hemi, key, rim);
      key.dispose();
      rim.dispose();
      hemi.dispose();
    },
  };
}

/**
 * Keeps a camera's aspect and near/far planes valid after a viewport change.
 *
 * Kept here rather than inline in the composition root so the "far plane must clear
 * the fog range" rule lives next to the fog it depends on. The far plane is
 * `max(arenaSpan * 3, RENDER.cameraFar)`: the first term guarantees the whole arena
 * is inside the frustum with room for the fog to work on, the second is a floor for
 * a designer who wants more.
 */
export function syncCameraProjection(camera: PerspectiveCamera, width: number, height: number): void {
  const aspect = height > 0 ? width / height : 1;
  if (camera.aspect !== aspect) camera.aspect = aspect;
  const arenaSpan = SIM.arenaHalfSize * 2;
  camera.near = 0.1;
  camera.far = Math.max(arenaSpan * 3, RENDER.cameraFar);
  camera.updateProjectionMatrix();
}

/** Detaches an object's children and frees them. Re-exported for the root. */
export function clearObject(object: Object3D): void {
  object.clear();
}
