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

import { CAMERA, PLAYER, VIEW, WEAPON } from '../../core/config';
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

/**
 * Which side of the player's head the camera is on.
 *
 * `firstPerson` is the brief's default: the camera sits at the eye and the body is not drawn,
 * so the crosshair is literally what the player is looking at. `thirdPerson` is the
 * over-the-shoulder rig phases 1-7 were tuned around. `V` toggles between them.
 */
export type ViewMode = 'firstPerson' | 'thirdPerson';

/** Every view mode, in toggle order. `V` cycles the list, so there is one list, not two. */
export const VIEW_MODES: readonly ViewMode[] = ['firstPerson', 'thirdPerson'];

/**
 * The other mode. Written as a lookup rather than as a two-branch ternary at the call site so
 * the toggle and the list above cannot disagree about how many modes exist.
 */
export function nextViewMode(mode: ViewMode): ViewMode {
  return VIEW_MODES[(VIEW_MODES.indexOf(mode) + 1) % VIEW_MODES.length] ?? 'firstPerson';
}

/**
 * The rig numbers for one view mode, resolved once per frame.
 *
 * Deliberately mutable: {@link resolveView} writes into a long-lived object per mode rather than
 * returning a fresh literal, because this runs every frame and the phase-4 rule that a
 * presentation `update()` allocates nothing applies to the camera as well.
 */
interface ViewGeometry {
  pivotRight: number;
  pivotUp: number;
  boomDistance: number;
  muzzleSide: number;
  muzzleDrop: number;
  followRate: number;
}

/**
 * Resolves a mode's rig numbers, **in place**, into preallocated storage.
 *
 * Every value is a lookup in {@link VIEW} keyed by the mode, so "which mode is which number"
 * is answered in exactly one place. The output object is reused across frames because this runs
 * inside `updateCamera` — the phase-4 rule that a presentation `update()` allocates nothing
 * applies to the camera too.
 */
function resolveView(out: ViewGeometry, mode: ViewMode): ViewGeometry {
  out.pivotRight = VIEW.pivotRight[mode];
  out.pivotUp = VIEW.pivotUp[mode];
  out.boomDistance = VIEW.boomDistance[mode];
  out.muzzleSide = VIEW.muzzleSide[mode];
  out.muzzleDrop = VIEW.muzzleDrop[mode];
  out.followRate = mode === 'firstPerson' ? VIEW.firstPersonFollowRate : CAMERA.followRate;
  return out;
}

/** Per-mode storage. One object per mode, written in place, never reallocated. */
const viewGeometry: Record<ViewMode, ViewGeometry> = {
  firstPerson: { pivotRight: 0, pivotUp: 0, boomDistance: 0, muzzleSide: 0, muzzleDrop: 0, followRate: 0 },
  thirdPerson: { pivotRight: 0, pivotUp: 0, boomDistance: 0, muzzleSide: 0, muzzleDrop: 0, followRate: 0 },
};

/**
 * Module-level scratch for the per-mode camera target.
 *
 * Module-level rather than per-`CameraState` because it is read and written inside a single
 * function call and never observed from outside; the alternative is one more field on every
 * camera state that only `updateCamera` would ever touch.
 */
const cameraTargetScratch: Vector3 = { x: 0, y: 0, z: 0 };

/**
 * Where the camera should be for one mode, into `out`.
 *
 * Split out of {@link updateCamera} so the first-person case is not "the same damping with a
 * zero offset bolted on". In first person the target **is** the pivot, and the damping only has to
 * absorb the one-tick gap between the simulated pivot and the frame being drawn — a fraction of a
 * millimetre at the first-person rate. In third person the target is the collision-solved boom
 * position, which is where the slow rate belongs: a lagging shoulder camera is what makes running
 * feel like it has weight, and a lagging *eye* is just the world sliding.
 */
function cameraTargetFor(out: Vector3, mode: ViewMode, pivot: Vector3, desired: Vector3): Vector3 {
  copy(out, mode === 'firstPerson' ? pivot : desired);
  return out;
}

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
  /**
   * Which view the rig is in, and the **single authority** for it.
   *
   * The simulation owns it because the aim solution is derived from it and the aim solution is
   * the simulation's: `V` flips this field through `World.toggleView()`, and the next tick's
   * `solveAim` reads it. The render layer only ever reads `camera.viewMode` back to decide
   * whether to draw the body. A second copy of "which view are we in" living in `main.ts` is the
   * two-sources-of-truth failure this project has already paid for twice.
   */
  viewMode: ViewMode;
  /** Yaw in radians, already including recoil. */
  yaw: number;
  /** Pitch in radians, already including recoil. Doubles as the camera's `x`. */
  pitch: number;
  /** Roll in radians. Recoil adds a slight twist; zero at rest. */
  roll: number;
  /** Field of view in degrees for the current ADS blend. */
  fovDeg: number;
  /**
   * Current distance behind the pivot, after any wall pull-in.
   *
   * Zero in first person, by construction: the eye is the pivot. Reported rather than special-
   * cased so the debug panel's "camera pinched" reading means the same thing in both modes.
   */
  distance: number;
  /** True when the boom was shortened by geometry. Surfaced by the debug panel. */
  pinched: boolean;
  /** Latest unit forward vector, so the renderer never has to re-derive it. */
  readonly forward: Vector3;
}

/** Creates a zeroed camera state, in the configured default view. */
export function createCameraState(): CameraState {
  return {
    position: { x: 0, y: 0, z: 0 },
    viewMode: CAMERA.defaultView,
    yaw: 0,
    pitch: 0,
    roll: 0,
    fovDeg: PLAYER.fovHip,
    distance: VIEW.boomDistance[CAMERA.defaultView],
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
 *
 * The **view mode** is read off the camera state, and it changes three numbers: where the pivot
 * is, how far behind it the camera wants to be, and where the tracer leaves from. It does not
 * change `forward`, so the mode is invisible to the shot's direction — which is the property
 * that makes toggling mid-fight safe. See {@link VIEW}.
 *
 * The parameter **defaults to third person**, matching `characterRig.sync`: a caller that hands in
 * a player and no mode is asking about the plain over-the-shoulder rig. `World` always passes the
 * camera's own mode explicitly, so the game never takes this default.
 */
export function solveAim(
  out: AimSolution,
  scratch: CameraScratch,
  player: PlayerState,
  solids: readonly Aabb[],
  viewMode: ViewMode = 'thirdPerson',
): AimSolution {
  const ads = player.weapon.adsProgress;
  const yaw = player.yaw;
  const pitch = player.pitch;
  const view = resolveView(viewGeometry[viewMode], viewMode);

  // The view basis. `right` must be the pitched right vector: the pivot and the
  // muzzle are offset along it, and any component that is not exactly orthogonal
  // to `forward` tilts the aim axis away from the crosshair.
  const right = rightFromYawPitch(scratch.direction, yaw, pitch);
  const up = upFromYawPitch(scratch.up, yaw, pitch);

  // --- Pivot: the shoulder (or the eye) the camera orbits --------------------
  const pivotRight = view.pivotRight +
    (VIEW.adsPivotRight[viewMode] - view.pivotRight) * ads;
  scratch.pivot.x = player.position.x + right.x * pivotRight;
  scratch.pivot.y = player.position.y + view.pivotUp;
  scratch.pivot.z = player.position.z + right.z * pivotRight;

  // --- Desired camera position, then pull-in --------------------------------
  const distance = view.boomDistance + (VIEW.adsBoomDistance[viewMode] - view.boomDistance) * ads;
  forwardFromYawPitch(scratch.forward, yaw, pitch);
  scratch.desired.x = scratch.pivot.x - scratch.forward.x * distance;
  scratch.desired.y = scratch.pivot.y - scratch.forward.y * distance;
  scratch.desired.z = scratch.pivot.z - scratch.forward.z * distance;

  // Sphere-cast the camera out of the level by shortening the boom. A zero-length boom cannot
  // hit anything, and in first person the boom *is* zero, so the sweep is skipped rather than
  // run on a degenerate ray every tick.
  const allowed = distance > 0
    ? clearBoom(scratch, scratch.pivot, scratch.forward, distance, solids)
    : { safeDistance: 0 };
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
  //
  // Both components are per-mode: an over-the-shoulder camera has the gun visibly beside the
  // crosshair, while a camera inside the head has it directly below. Reusing the third-person
  // pair in first person would send every tracer on a diagonal that grows with distance — a
  // miss the player can see but the crosshair cannot explain.
  const muzzleSide = view.muzzleSide;
  const muzzleDrop = view.muzzleDrop;
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
 * Ordering: player angles → recoil offset → target for the mode → damped position → hard
 * un-stick.
 *
 * Rotation is *not* damped — a lagged rotation feels like input delay, which is
 * the most damaging thing a shooter camera can do. Position is damped, and then
 * clamped again, because damping an already-collision-solved target can still
 * leave the camera inside a wall for a few frames when the player spins.
 *
 * **The target depends on the view mode.** Third person damps toward the collision-solved boom
 * position; first person goes straight to the pivot, at `firstPersonFollowRate`. Damping a
 * camera that is supposed to be an eye is the "the world slides when I walk" defect, so the
 * first-person case is exact rather than merely fast.
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

  const view = resolveView(viewGeometry[camera.viewMode], camera.viewMode);
  const target = cameraTargetFor(cameraTargetScratch, camera.viewMode, aim.pivot, aim.desiredPosition);

  // Exponential damping so the camera settles identically at every frame rate. At the
  // first-person rate this converges within a couple of frames, which is the point: the camera
  // is the eye, and the damping only exists to absorb the one-tick gap between the simulation's
  // pivot and the frame being drawn.
  const factor = 1 - Math.exp(-view.followRate * dt);
  camera.position.x += (target.x - camera.position.x) * factor;
  camera.position.y += (target.y - camera.position.y) * factor;
  camera.position.z += (target.z - camera.position.z) * factor;

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
  // Reported honestly so the debug panel can flag "camera pinched" as a level bug. First person
  // can never pinch — there is no boom to shorten — and that falls out of the per-mode distance
  // rather than needing its own branch.
  camera.pinched = camera.distance < view.boomDistance - 0.05;
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

/**
 * Snaps the camera to its ideal pose, bypassing damping. Used on spawn.
 *
 * The mode-aware target matters here too: spawning in first person and snapping to the
 * third-person boom position would put the camera three metres behind the player's head for the
 * first frames of every run and every restart. It is also what makes a `V` press cheap to land —
 * the caller snaps and the mode is applied with no transition to get wrong.
 */
export function snapCamera(camera: CameraState, aim: AimSolution, player: PlayerState): void {
  const target = cameraTargetFor(cameraTargetScratch, camera.viewMode, aim.pivot, aim.desiredPosition);
  copy(camera.position, target);
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
