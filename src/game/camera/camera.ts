/**
 * Over-the-shoulder camera.
 *
 * Pure math over a plain {@link CameraState}. `render/main` copies that state
 * onto a `THREE.PerspectiveCamera` once per frame; no rendering type appears
 * here, which is why camera behaviour (ADS transition, recoil, wall pull-in) can
 * be asserted in a test instead of eyeballed.
 *
 * Three things this module is responsible for, in priority order:
 *
 *   1. **Convergence.** The muzzle and the camera are at different points, so a
 *      bullet fired along the camera's forward axis would miss whatever the
 *      crosshair is on. The aim point is therefore projected from the camera
 *      along its own forward vector, and the shot is traced *toward* that point
 *      from the muzzle. The tracer and the crosshair agree by construction.
 *   2. **Never inside geometry.** The rig is pulled in along the pivot→camera
 *      line until it clears the level.
 *   3. **Recoil on top, not inside.** Recoil is an additive visual offset; it
 *      never mutates the player's authoritative yaw/pitch. That separation is
 *      what lets the player fight the climb while the shot direction stays
 *      exactly where the crosshair says.
 */

import { CAMERA, PLAYER, WEAPON } from '../../core/config';
import {
  type Aabb,
  type Vector3,
  DEG2RAD,
  RAD2DEG,
  clamp,
  copy,
  forwardFromYawPitch,
  rightFromYawPitch,
  upFromYawPitch,
} from '../../core/math/vec3';
import { createRayHit, pointInAabb, rayAabb } from '../../core/math/intersect';
import type { PlayerState } from '../player/player';

/** Where the shot is traced from and what it is traced toward. */
export interface AimSolution {
  readonly muzzle: Vector3;
  readonly aimPoint: Vector3;
  readonly direction: Vector3;
  /** Degrees of optical field of view for the current ADS blend. */
  fovDeg: number;
  /** Position of the camera pivot, for the camera pull-in solve. */
  readonly pivot: Vector3;
  readonly desiredPosition: Vector3;
}

/** Camera pose, ready to be copied onto a render camera. */
export interface CameraState {
  readonly position: Vector3;
  /** Yaw in radians, already including recoil. */
  yaw: number;
  /** Pitch in radians, already including recoil. Doubles as the camera's `x`. */
  pitch: number;
  /** Roll in radians. Recoil adds a slight twist; zero at rest. */
  roll: number;
  /** Field of view in degrees for the current ADS blend. */
  fovDeg: number;
  /** Current distance behind the pivot, after any wall pull-in. */
  distance: number;
  /** True when the boom was shortened by geometry. Surfaced by the debug panel. */
  pinched: boolean;
  /** Latest unit forward vector, so the renderer never has to re-derive it. */
  readonly forward: Vector3;
}

/** Creates a zeroed camera state. */
export function createCameraState(): CameraState {
  return {
    position: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    roll: 0,
    fovDeg: PLAYER.fovHip,
    distance: CAMERA.hipDistance,
    pinched: false,
    forward: { x: 0, y: 0, z: -1 },
  };
}

/** Scratch buffers, so the camera allocates nothing per frame. */
interface CameraScratch {
  forward: Vector3;
  up: Vector3;
  pivot: Vector3;
  desired: Vector3;
  direction: Vector3;
  hit: ReturnType<typeof createRayHit>;
}

/** Creates the camera scratch buffer. */
export function createCameraScratch(): CameraScratch {
  return {
    forward: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    pivot: { x: 0, y: 0, z: 0 },
    desired: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: 0 },
    hit: createRayHit(),
  };
}

/**
 * Solves the current shot frame for a player.
 *
 * The crosshair is authoritative: `aimPoint` is `pivot + forward × range`, and the
 * reported `direction` is that same forward vector. Because the muzzle offset is a
 * sum of two components orthogonal to forward, the direction from the muzzle to
 * the aim point is identical — so the crosshair, the tracer and the impact all
 * coincide.
 *
 * **The aim angles come from the player, not from the rendered camera.** Recoil is
 * a *visual* offset applied later in {@link updateCamera}; reading it here would
 * make the shot follow the recoil climb, which is the opposite of a learnable
 * recoil pattern. More importantly, the camera pose is only refreshed once per
 * *rendered frame* while this runs once per *simulation tick*, so at 144 FPS or
 * during a long frame the two clock domains diverge and a shot would be traced
 * along an angle the player has already moved away from.
 */
export function solveAim(
  out: AimSolution,
  scratch: CameraScratch,
  player: PlayerState,
  solids: readonly Aabb[],
): AimSolution {
  const ads = player.weapon.adsProgress;
  const yaw = player.yaw;
  const pitch = player.pitch;

  // The view basis. `right` must be the pitched right vector: the pivot and the
  // muzzle are offset along it, and any component that is not exactly orthogonal
  // to `forward` tilts the aim axis away from the crosshair.
  const right = rightFromYawPitch(scratch.direction, yaw, pitch);
  const up = upFromYawPitch(scratch.up, yaw, pitch);

  // --- Pivot: the shoulder the camera orbits ---------------------------------
  const pivotRight = CAMERA.pivotRight + (CAMERA.adsPivotRight - CAMERA.pivotRight) * ads;
  scratch.pivot.x = player.position.x + right.x * pivotRight;
  scratch.pivot.y = player.position.y + CAMERA.pivotUp;
  scratch.pivot.z = player.position.z + right.z * pivotRight;

  // --- Desired camera position, then pull-in --------------------------------
  const distance = CAMERA.hipDistance + (CAMERA.adsDistance - CAMERA.hipDistance) * ads;
  forwardFromYawPitch(scratch.forward, yaw, pitch);
  scratch.desired.x = scratch.pivot.x - scratch.forward.x * distance;
  scratch.desired.y = scratch.pivot.y - scratch.forward.y * distance;
  scratch.desired.z = scratch.pivot.z - scratch.forward.z * distance;

  // Sphere-cast the camera out of the level by shortening the boom.
  const allowed = clearBoom(scratch, scratch.pivot, scratch.forward, distance, solids);
  const finalDistance = allowed.safeDistance;

  copy(out.pivot, scratch.pivot);
  copy(out.desiredPosition, scratch.desired);
  if (finalDistance < distance) {
    out.desiredPosition.x = scratch.pivot.x - scratch.forward.x * finalDistance;
    out.desiredPosition.y = scratch.pivot.y - scratch.forward.y * finalDistance;
    out.desiredPosition.z = scratch.pivot.z - scratch.forward.z * finalDistance;
  }

  // --- Muzzle: down the barrel, on the camera's forward axis -----------------
  // Offset sideways and *down* in the view basis so the tracer reads as coming
  // from the weapon rather than from between the eyes. The offset is a vector sum
  // of two components that are both exactly orthogonal to `forward`, so it cannot
  // rotate the aim axis no matter how large it gets. The vertical term is
  // subtracted because `up` points toward the sky.
  const muzzleSide = CAMERA.muzzleSide;
  const muzzleDrop = CAMERA.muzzleDrop;
  out.muzzle.x = scratch.pivot.x + right.x * muzzleSide - up.x * muzzleDrop;
  out.muzzle.y = scratch.pivot.y - up.y * muzzleDrop;
  out.muzzle.z = scratch.pivot.z + right.z * muzzleSide - up.z * muzzleDrop;

  // The point the crosshair is on: straight out from the pivot along the view
  // axis. The shot is traced from the muzzle *toward* this point, which is why
  // the crosshair and the tracer agree.
  const range = WEAPON.range;
  out.aimPoint.x = scratch.pivot.x + scratch.forward.x * range;
  out.aimPoint.y = scratch.pivot.y + scratch.forward.y * range;
  out.aimPoint.z = scratch.pivot.z + scratch.forward.z * range;

  /**
   * Reported direction.
   *
   * Mathematically this is `normalise(aimPoint − muzzle)`, but it is written as
   * the forward vector directly. The two are identical — the muzzle offset is
   * orthogonal to forward, so it cancels on normalisation — and taking the
   * difference of two points ~120 m apart that differ by ~0.3 m costs five
   * significant digits to catastrophic cancellation. That is a measurable (if
   * small) aim error, and it is entirely avoidable. `tests/camera.test.ts` pins
   * the equivalence so the shortcut can never silently diverge from the geometry.
   */
  out.direction.x = scratch.forward.x;
  out.direction.y = scratch.forward.y;
  out.direction.z = scratch.forward.z;

  out.fovDeg = PLAYER.fovHip + (PLAYER.fovAds - PLAYER.fovHip) * ads;
  return out;
}

/** Allocates an empty {@link AimSolution} for `solveAim` to fill. */
export function createAimSolution(): AimSolution {
  return {
    muzzle: { x: 0, y: 0, z: 0 },
    aimPoint: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: 0 },
    fovDeg: PLAYER.fovHip,
    pivot: { x: 0, y: 0, z: 0 },
    desiredPosition: { x: 0, y: 0, z: 0 },
  };
}

/**
 * Shortens the camera boom until the rig clears the level.
 *
 * Modelled as a sphere sweep along `forward`, which is what makes it robust at
 * corners: a pure ray test lets the camera clip the edge of a crate that the ray
 * passed beside.
 */
function clearBoom(
  scratch: CameraScratch,
  pivot: Vector3,
  forward: Vector3,
  distance: number,
  solids: readonly Aabb[],
): { safeDistance: number } {
  if (solids.length === 0) return { safeDistance: distance };

  // The sweep is a sphere of `collisionRadius` travelling along `forward`, so
  // test against boxes inflated by that radius. The pivot itself is never
  // inflated: the player is not a bullet target here.
  let closest = distance;
  for (const box of solids) {
    const inflated: Aabb = {
      center: box.center,
      halfExtents: {
        x: box.halfExtents.x + CAMERA.collisionRadius,
        y: box.halfExtents.y + CAMERA.collisionRadius,
        z: box.halfExtents.z + CAMERA.collisionRadius,
      },
    };
    const hit = rayAabb(scratch.hit, pivot, forward, inflated);
    if (!hit) continue;
    // Only the forward half of the boom matters; a hit behind the pivot is a box
    // the player is already clear of.
    if (hit.t <= 0) continue;
    if (hit.t < closest) closest = hit.t;
  }

  // Keep a minimum boom so the camera never coincides with the pivot: at zero
  // distance the near plane clips through the character's head.
  return { safeDistance: clamp(closest, CAMERA.minDistance, distance) };
}

/**
 * Applies recoil, ADS and position damping to produce the final camera pose.
 *
 * Ordering: player angles → recoil offset → damped position → hard un-stick.
 *
 * Rotation is *not* damped — a lagged rotation feels like input delay, which is
 * the most damaging thing a shooter camera can do. Position is damped, and then
 * clamped again, because damping an already-collision-solved target can still
 * leave the camera inside a wall for a few frames when the player spins.
 */
export function updateCamera(
  camera: CameraState,
  player: PlayerState,
  aim: AimSolution,
  recoilPitchDeg: number,
  recoilYawDeg: number,
  dt: number,
  solids: readonly Aabb[],
): CameraState {
  camera.yaw = player.yaw + recoilYawDeg * DEG2RAD;
  camera.pitch = clamp(
    player.pitch + recoilPitchDeg * DEG2RAD,
    -PLAYER.pitchClampDeg * DEG2RAD,
    PLAYER.pitchClampDeg * DEG2RAD,
  );
  // A small counter-roll on the recoil makes sustained fire read as "the gun is
  // pushing" rather than "the world is tilting".
  camera.roll = -recoilYawDeg * 0.35 * DEG2RAD;

  // Exponential damping so the camera settles identically at every frame rate.
  const factor = 1 - Math.exp(-CAMERA.followRate * dt);
  camera.position.x += (aim.desiredPosition.x - camera.position.x) * factor;
  camera.position.y += (aim.desiredPosition.y - camera.position.y) * factor;
  camera.position.z += (aim.desiredPosition.z - camera.position.z) * factor;

  // Second collision pass, on the damped result. Cheaper and more robust than
  // trying to make the damping itself collision-aware.
  unstickCamera(camera.position, solids);

  forwardFromYawPitch(camera.forward, camera.yaw, camera.pitch);
  camera.fovDeg = aim.fovDeg;
  camera.distance = Math.hypot(
    camera.position.x - aim.pivot.x,
    camera.position.y - aim.pivot.y,
    camera.position.z - aim.pivot.z,
  );
  // Reported honestly so the debug panel can flag "camera pinched" as a level bug.
  camera.pinched = camera.distance < CAMERA.hipDistance - 0.05;
  return camera;
}

/**
 * Pushes the camera out of any solid it ended up inside.
 *
 * Uses the shallowest axis of the overlap, which is the same rule the player
 * controller uses — one un-stick rule for the whole codebase is easier to reason
 * about than two slightly different ones.
 */
function unstickCamera(position: Vector3, solids: readonly Aabb[]): void {
  const radius = CAMERA.collisionRadius;
  for (const box of solids) {
    if (!pointInAabb(position, box)) continue;
    const dxPos = box.center.x + box.halfExtents.x - position.x;
    const dxNeg = position.x - (box.center.x - box.halfExtents.x);
    const dyPos = box.center.y + box.halfExtents.y - position.y;
    const dyNeg = position.y - (box.center.y - box.halfExtents.y);
    const dzPos = box.center.z + box.halfExtents.z - position.z;
    const dzNeg = position.z - (box.center.z - box.halfExtents.z);

    const depth = Math.min(dxPos, dxNeg, dyPos, dyNeg, dzPos, dzNeg);
    if (depth === dxPos) position.x += dxPos + radius;
    else if (depth === dxNeg) position.x -= dxNeg + radius;
    else if (depth === dyPos) position.y += dyPos + radius;
    else if (depth === dyNeg) position.y -= dyNeg + radius;
    else if (depth === dzPos) position.z += dzPos + radius;
    else position.z -= dzNeg + radius;
  }
}

/** Snaps the camera to its ideal pose, bypassing damping. Used on spawn. */
export function snapCamera(camera: CameraState, aim: AimSolution, player: PlayerState): void {
  copy(camera.position, aim.desiredPosition);
  camera.yaw = player.yaw;
  camera.pitch = player.pitch;
  camera.roll = 0;
  camera.fovDeg = aim.fovDeg;
  camera.pinched = false;
  forwardFromYawPitch(camera.forward, camera.yaw, camera.pitch);
}

/** Converts a spread half-angle to a crosshair radius in screen pixels. */
export function spreadToScreenRadius(spreadDeg: number, fovDeg: number, viewportHeight: number): number {
  // Small-angle projection of a cone half-angle onto the view plane. Exact enough
  // for a crosshair, and — importantly — it uses the *vertical* FOV so the
  // crosshair tracks the zoom instead of fighting it.
  const halfFovRad = (fovDeg * 0.5) * DEG2RAD;
  if (halfFovRad <= 0 || halfFovRad >= Math.PI / 2) return 0;
  const tanHalf = Math.tan(halfFovRad);
  return (Math.tan(spreadDeg * DEG2RAD) / tanHalf) * (viewportHeight * 0.5);
}

/** Degrees in a radian measure, re-exported so the render layer need not import math. */
export { RAD2DEG };
