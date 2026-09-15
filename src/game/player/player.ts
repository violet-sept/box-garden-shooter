/**
 * Player state and kinematic controller.
 *
 * The controller is a capsule on a box world: no physics engine, no rigid
 * bodies (technical plan §2.3). What it actually has to do is small and
 * specific — accelerate, stop, slide along walls, climb a curb, fall — and
 * writing it directly means the solve order is visible and testable instead of
 * buried in a contact solver.
 *
 * Solve order per tick, which is the whole design:
 *   1. Look (yaw/pitch, pitch clamped so the horizon never flips).
 *   2. Build the target velocity **from yaw only**. Movement must never be
 *      pitched, or looking at the floor would drive the player into it.
 *   3. Integrate X, then Z, resolving penetration after each. Separating the
 *      horizontal axes is what produces wall-sliding for free.
 *   4. Vertical last: arrive, snap, or fall. Landing can never be undone by the
 *      horizontal step because it happens after it.
 *
 * Everything reads from `core/config`. There are no local tuning constants.
 */

import { PLAYER } from '../../core/config';
import { type Aabb, type Vector3, clamp, wrapAngle } from '../../core/math/vec3';
import { createRayHit, rayAabb, type RayHit } from '../../core/math/intersect';
import type { InputIntent } from '../../core/input';
import type { LevelData } from '../level';
import type { WeaponState } from './weapon';

/** Live player state. */
export interface PlayerState {
  readonly position: Vector3;
  readonly velocity: Vector3;
  /** Rotation about Y, radians. 0 faces −Z. */
  yaw: number;
  /** Rotation about X, radians. Positive looks up. */
  pitch: number;
  health: number;
  readonly maxHealth: number;
  grounded: boolean;
  /** Simulation time of the last landing; used for a camera dip in phase 4. */
  lastLandTime: number;
  /** Speed along the horizontal plane, cached for the HUD and camera bob. */
  horizontalSpeed: number;
  /** True when the player asked to sprint and had the space to do it. */
  sprinting: boolean;
  readonly weapon: WeaponState;

  // --- Combat bookkeeping (phase 2). See `game/player/combat.ts`. -----------
  /**
   * Seconds of invulnerability remaining.
   *
   * Counted down on simulation time, not render time: an i-frame window measured
   * against the render clock is frame-rate dependent, and 0.35 s at 144 Hz would
   * buy a third less protection than at 60 Hz.
   */
  invulnerableFor: number;
  /** Simulation time of the last damage taken; anchors the regeneration delay. */
  lastDamageTime: number;
  /** Where the last hit came from, for directional damage feedback. */
  readonly lastDamageFrom: Vector3;
  /** Total damage taken this life. Shown in the debug panel. */
  damageTaken: number;
  /** True once health has reached zero. */
  dead: boolean;
}

/** The collision world the controller walks on. */
export interface CollisionWorld {
  /** Solid geometry. The ground slab is *not* here; see {@link createCollisionWorld}. */
  readonly obstacles: readonly Aabb[];
  /**
   * Geometry that also stops bullets and vision: the same list minus fences.
   *
   * The camera needs this rather than `obstacles`, because the camera may pass
   * through the fence (it is a visual boundary for the player, not a wall for the
   * view) but must never end up behind a crate.
   */
  readonly solids: readonly Aabb[];
  /** Half-extent of the playable footprint. */
  readonly halfSize: number;
}

/**
 * Splits level geometry into the lists the controller actually wants.
 *
 * The floor slab is excluded from `obstacles` on purpose: it is coplanar with the
 * player's feet, so feeding it to the penetration solver would eject the player
 * upward every tick. Floors are handled by an exact downward ray instead, which is
 * both cheaper and more accurate for step-up. Fences stay in: they are
 * full-height obstacles that exist precisely to stop horizontal movement.
 *
 * The test for "is this the floor" is **"is its top at or below the feet"**, not
 * "is it the ground prop": that is the property the solver actually needs, and it keeps
 * being right for anything buried in the slab. It is also what lets this function read
 * `level.collisionBoxes` — the one authoring list, built from `props` *and* the decorative
 * pieces — instead of re-deriving a second, subtly different one from `props` alone. The
 * two derivations were equal until decorations became solid, at which point only one of
 * them would have known it.
 */
export function createCollisionWorld(level: LevelData): CollisionWorld {
  const obstacles: Aabb[] = [];
  for (const box of level.collisionBoxes) {
    if (box.center.y + box.halfExtents.y <= 0) continue;
    obstacles.push(box);
  }
  return { obstacles, solids: level.blockers, halfSize: level.halfSize };
}

/** Creates the initial player state, standing at the south end of the arena. */
export function createPlayerState(weapon: WeaponState): PlayerState {
  return {
    position: { x: 0, y: 0, z: 8 },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    health: PLAYER.maxHealth,
    maxHealth: PLAYER.maxHealth,
    grounded: true,
    lastLandTime: 0,
    horizontalSpeed: 0,
    sprinting: false,
    weapon,
    // Duplicated from `game/player/combat.ts` rather than imported, because that
    // module imports this one for the `PlayerState` type and the cycle would make
    // the initial value order-dependent. The values are not tuning knobs.
    invulnerableFor: 0,
    lastDamageTime: -Infinity,
    lastDamageFrom: { x: 0, y: 0, z: 0 },
    damageTaken: 0,
    dead: false,
  };
}

/** Restores a player to spawn condition. */
export function resetPlayerState(state: PlayerState): void {
  state.position.x = 0;
  state.position.y = 0;
  state.position.z = 8;
  state.velocity.x = 0;
  state.velocity.y = 0;
  state.velocity.z = 0;
  state.health = state.maxHealth;
  state.grounded = true;
  state.horizontalSpeed = 0;
  state.sprinting = false;
  state.yaw = 0;
  state.pitch = 0;
  state.invulnerableFor = 0;
  state.lastDamageTime = -Infinity;
  state.lastDamageFrom.x = 0;
  state.lastDamageFrom.y = 0;
  state.lastDamageFrom.z = 0;
  state.damageTaken = 0;
  state.dead = false;
}

/** Scratch buffers so the controller allocates nothing per tick. */
export interface MovementScratch {
  readonly hit: RayHit;
  readonly probeOrigin: Vector3;
  readonly down: Vector3;
}

/** Creates the per-player scratch buffer. */
export function createMovementScratch(): MovementScratch {
  return {
    hit: createRayHit(),
    probeOrigin: { x: 0, y: 0, z: 0 },
    down: { x: 0, y: -1, z: 0 },
  };
}

/**
 * Highest surface directly under the capsule within `maxDrop`, or `null`.
 *
 * Two details make this work when the player is flush against a curb, and both
 * matter:
 *
 *   1. **The probe point is clamped into the obstacle's footprint.** A plain ray
 *      down from the capsule centre exits through the *side* of a step the player
 *      is standing against, so it reports no ground and the player is blocked by a
 *      0.3 m ledge forever. Clamping the ray's x/z to the obstacle's (radius-
 *      expanded) footprint forces it to enter through the top face, which is the
 *      surface that actually supports the capsule.
 *   2. **The seed is the arena floor at y = 0.** Standing on nothing but the
 *      ground needs no special case and no ground entry in the obstacle list.
 */
function probeGround(
  scratch: MovementScratch,
  world: CollisionWorld,
  position: Vector3,
  maxDrop: number,
): number | null {
  let best = 0;
  let found = maxDrop >= 0;
  const centerY = position.y + PLAYER.height * 0.5;

  for (const box of world.obstacles) {
    // Only obstacles the capsule actually overlaps in plan can support it.
    const overlapX = box.halfExtents.x + PLAYER.radius - Math.abs(position.x - box.center.x);
    if (overlapX <= 0) continue;
    const overlapZ = box.halfExtents.z + PLAYER.radius - Math.abs(position.z - box.center.z);
    if (overlapZ <= 0) continue;

    const minX = box.center.x - box.halfExtents.x;
    const maxX = box.center.x + box.halfExtents.x;
    const minZ = box.center.z - box.halfExtents.z;
    const maxZ = box.center.z + box.halfExtents.z;
    scratch.probeOrigin.x = Math.min(Math.max(position.x, minX), maxX);
    scratch.probeOrigin.y = centerY;
    scratch.probeOrigin.z = Math.min(Math.max(position.z, minZ), maxZ);

    const hit = rayAabb(scratch.hit, scratch.probeOrigin, scratch.down, box);
    if (!hit || hit.t <= 0 || hit.t > maxDrop) continue;
    // A hit on a vertical face is not a floor. Reject anything but an upward
    // normal, or the player would be lifted onto a wall they are leaning on.
    if (hit.normal.y < 0.5) continue;
    const surface = scratch.probeOrigin.y - hit.t;
    if (surface > best) {
      best = surface;
      found = true;
    }
  }
  return found ? best : null;
}

/**
 * Resolves the capsule out of every overlapping obstacle.
 *
 * Separating-axis-lite: the cheapest axis pushes the capsule out with the least
 * disturbance, which is what makes a player slide along a wall rather than being
 * ejected sideways from it.
 *
 * @param horizontalOnly When true, only X/Z are resolved. The vertical pass is a
 *                       separate call because the two need different velocity
 *                       handling.
 * @returns true when at least one correction was applied.
 */
function resolvePenetration(
  world: CollisionWorld,
  position: Vector3,
  velocity: Vector3,
  horizontalOnly: boolean,
): boolean {
  let touched = false;
  const capsuleCenterY = position.y + PLAYER.height * 0.5;

  for (const box of world.obstacles) {
    const overlapX = box.halfExtents.x + PLAYER.radius - Math.abs(position.x - box.center.x);
    if (overlapX <= 0) continue;
    const overlapZ = box.halfExtents.z + PLAYER.radius - Math.abs(position.z - box.center.z);
    if (overlapZ <= 0) continue;
    const overlapY = box.halfExtents.y + PLAYER.height * 0.5 - Math.abs(capsuleCenterY - box.center.y);
    if (overlapY <= 0) continue;

    if (horizontalOnly) {
      if (overlapX <= overlapZ) {
        const sign = position.x < box.center.x ? -1 : 1;
        position.x += overlapX * sign;
        if (Math.sign(velocity.x) === sign) velocity.x = 0;
      } else {
        const sign = position.z < box.center.z ? -1 : 1;
        position.z += overlapZ * sign;
        if (Math.sign(velocity.z) === sign) velocity.z = 0;
      }
    } else {
      const sign = capsuleCenterY < box.center.y ? -1 : 1;
      position.y += overlapY * sign;
      if (sign > 0 && velocity.y < 0) velocity.y = 0;
      if (sign < 0 && velocity.y > 0) velocity.y = 0;
    }
    touched = true;
  }
  return touched;
}

/** What the caller may want to react to after a movement tick. */
export interface PlayerTickResult {
  /** True on the tick the player's feet meet ground after being airborne. */
  readonly landed: boolean;
  readonly grounded: boolean;
  readonly horizontalSpeed: number;
}

/**
 * Advances player movement by one fixed tick.
 *
 * @param dt   Always `1 / SIM.tickHz`. Passed in rather than imported so tests can
 *             drive the controller at other rates and prove frame-rate independence.
 * @param time Absolute simulation time, used only for bookkeeping.
 */
export function tickPlayer(
  state: PlayerState,
  scratch: MovementScratch,
  world: CollisionWorld,
  intent: InputIntent,
  dt: number,
  time: number,
): PlayerTickResult {
  // --- 1. Look --------------------------------------------------------------
  // The look delta already represents the whole tick's mouse motion, so folding
  // it in here (rather than in the render callback) is what makes sensitivity
  // identical at every frame rate.
  const lookScale = 1 + (PLAYER.adsSensitivityScale - 1) * state.weapon.adsProgress;
  state.yaw = wrapAngle(state.yaw - intent.lookDeltaX * PLAYER.lookSensitivity * lookScale);
  const pitchLimit = PLAYER.pitchClampDeg * (Math.PI / 180);
  state.pitch = clamp(
    state.pitch - intent.lookDeltaY * PLAYER.lookSensitivity * lookScale,
    -pitchLimit,
    pitchLimit,
  );

  // --- 2. Desired velocity, from yaw only ----------------------------------
  const moveScale = 1 + (PLAYER.adsMoveScale - 1) * state.weapon.adsProgress;
  const wantsSprint = intent.sprint && intent.move.forward > 0;
  const maxSpeed = (wantsSprint ? PLAYER.sprintSpeed : PLAYER.walkSpeed) * moveScale;

  // Forward is −Z rotated by yaw, matching `forwardFromYawPitch` exactly. Getting
  // this convention wrong is the classic "A moves me right" bug.
  const sinYaw = Math.sin(state.yaw);
  const cosYaw = Math.cos(state.yaw);
  const forwardX = -sinYaw;
  const forwardZ = -cosYaw;
  const rightX = cosYaw;
  const rightZ = -sinYaw;

  let inputX = forwardX * intent.move.forward + rightX * intent.move.right;
  let inputZ = forwardZ * intent.move.forward + rightZ * intent.move.right;
  const inputLength = Math.hypot(inputX, inputZ);
  if (inputLength > 1e-4) {
    // Normalise so a diagonal W+D is not faster than a straight W.
    inputX /= inputLength;
    inputZ /= inputLength;
  } else {
    inputX = 0;
    inputZ = 0;
  }

  // --- 3. Accelerate toward the target -------------------------------------
  // The rate is derived from the configured time-to-speed, so "0.18 s to full
  // speed" in config means exactly that at any tick rate.
  const accelRate = inputLength > 1e-4
    ? 1 / Math.max(PLAYER.accelerationTime, 1e-4)
    : 1 / Math.max(PLAYER.decelerationTime, 1e-4);
  const accelFactor = 1 - Math.exp(-accelRate * dt);
  state.velocity.x += (inputX * maxSpeed - state.velocity.x) * accelFactor;
  state.velocity.z += (inputZ * maxSpeed - state.velocity.z) * accelFactor;

  // --- 4. Integrate and resolve, one horizontal axis at a time -------------
  state.position.x += state.velocity.x * dt;
  resolvePenetration(world, state.position, state.velocity, true);
  state.position.z += state.velocity.z * dt;
  resolvePenetration(world, state.position, state.velocity, true);

  // A second pass catches the inside-corner case where resolving X pushes the
  // capsule into a box the Z pass had already cleared.
  if (resolvePenetration(world, state.position, state.velocity, true)) {
    resolvePenetration(world, state.position, state.velocity, true);
  }

  // Hard clamp as a backstop: even with mis-authored geometry, the player cannot
  // leave the diorama.
  const limit = world.halfSize - PLAYER.radius;
  state.position.x = clamp(state.position.x, -limit, limit);
  state.position.z = clamp(state.position.z, -limit, limit);

  // --- 5. Jump --------------------------------------------------------------
  if (intent.jump && state.grounded) {
    state.velocity.y = PLAYER.jumpVelocity;
    state.grounded = false;
  }

  // --- 6. Step up, then settle vertically ----------------------------------
  //
  // Step-up happens *before* the ground check, and it is what makes a low ledge
  // walkable. The horizontal solve above deliberately stops the capsule at the
  // face of anything it overlaps, which — without this — leaves the player pinned
  // against a 0.3 m kerb forever, because the downward probe from *behind* the
  // face grazes the top edge and exits through the side of the box instead of
  // landing on it. Lifting first puts the feet on the surface, after which the
  // settle below simply confirms it.
  //
  // The probe reach is deliberately *not* gated on `grounded`. Gating it was a
  // real bug: once a step lifted the feet, the next tick's shorter probe could no
  // longer see the very surface it had just been placed on, so the player fell off
  // the ledge they were standing on. One reach, applied every tick, keeps the
  // state machine monotone.
  //
  // The probe fires from the capsule's *centre* (base + height/2), so the budget
  // has to include that half-height before the snap and step allowances. Leaving
  // it out was the second half of the same bug: a 0.875 m ray was being compared
  // against a 0.7 m budget, so the probe could not see the surface underfoot.
  const wasGrounded = state.grounded;
  const probeReach = PLAYER.height * 0.5 + PLAYER.groundSnapDistance + PLAYER.stepHeight;
  const ground = probeGround(scratch, world, state.position, probeReach);

  // A step is a lateral manoeuvre: it is only taken while calm and only ever
  // upward. It must not fire mid-jump, or a player rising past a ledge would be
  // snapped onto its roof.
  if (wasGrounded && state.velocity.y <= 0 && ground !== null && ground > state.position.y) {
    if (ground - state.position.y <= PLAYER.stepHeight) {
      state.position.y = ground;
      state.velocity.y = 0;
    }
  }

  state.velocity.y -= PLAYER.gravity * dt;
  state.position.y += state.velocity.y * dt;

  // Headroom, and only while rising: the falling case is settled by the ground
  // check below, and running both would fight over the same axis.
  if (state.velocity.y > 0) {
    resolvePenetration(world, state.position, state.velocity, false);
  }

  let landed = false;
  if (ground !== null && state.velocity.y <= 0 && state.position.y <= ground + PLAYER.groundSnapDistance) {
    state.position.y = ground;
    if (!wasGrounded) landed = true;
    state.velocity.y = 0;
    state.grounded = true;
    if (landed) state.lastLandTime = time;
  } else {
    state.grounded = false;
  }

  // Backstop against ever falling out of the world.
  if (state.position.y < -2) {
    state.position.y = 0;
    state.velocity.y = 0;
    state.grounded = true;
  }

  state.horizontalSpeed = Math.hypot(state.velocity.x, state.velocity.z);
  state.sprinting = wantsSprint && state.horizontalSpeed > PLAYER.walkSpeed * 0.9;

  return { landed, grounded: state.grounded, horizontalSpeed: state.horizontalSpeed };
}

/** Writes the player's eye position into `out`. */
export function eyePosition(out: Vector3, state: PlayerState): Vector3 {
  out.x = state.position.x;
  out.y = state.position.y + PLAYER.eyeHeight;
  out.z = state.position.z;
  return out;
}
