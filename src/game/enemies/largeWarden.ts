/**
 * Large enemy AI: the Warden.
 *
 * `SPAWN → IDLE → REPOSITION → TELEGRAPH → SHOT → RECOVER → (ENRAGE) → DEAD`.
 *
 * The archetype's whole identity is that it does not chase. It holds an 18–26 m
 * band and fires a **straight yellow shot** down the line between itself and the
 * player, so it punishes "standing in the open and not moving" where the Stalker
 * punishes "standing still". Everything below is in service of three design
 * constraints:
 *
 *   1. **The telegraph is 1.35 s and is never shortened.** It is the reaction
 *      budget, and the only thing that separates "hard" from "unfair" (brief
 *      section 1.5, hard rule 9). Enrage compresses recovery and cooldown only —
 *      `frames.ts` takes the scale as a parameter and never applies it to the
 *      telegraph, which is how that rule is enforced in code rather than in a
 *      comment.
 *   2. **The line is shown while it is still being aimed, and frozen the instant it
 *      fires.** During the wind-up `enemy.aim` is rewritten every tick from the
 *      player's *current* position, and the presentation layer draws exactly that
 *      line; at the end of the wind-up the same values are handed to the store, which
 *      copies them into a projectile that never re-aims. A shot that tracked the
 *      player in flight would not be dodgeable — only lucky — and randomised damage is
 *      the opposite of the readable rhythm the brief is built around.
 *   3. **It is aimed at where the player *is*, not where they are going.** The
 *      phase-2 version led its target because it was dropping area blasts on ground
 *      the player would run across; a line that is offset from the player's actual
 *      position visibly misses the thing it is pointing at, which is worse than
 *      being dodgeable. Stepping off the line is the counterplay, and it has to be a
 *      counterplay the player can *see* working.
 */

import { ENEMY, ENRAGE_COOLDOWN_SCALE, PLAYER, WARDEN } from '../../core/config';
import { type Vector3, distanceXZ, set } from '../../core/math/vec3';
import { phaseAt, telegraphProgress } from './frames';
import { attackFrameFor, type EnemyState, type WardenAim } from './EnemyState';
import { clampSpeed, keepDistance } from './steering';
import type { EnemyContext, EnemyStore } from './EnemyStore';

/** Scratch vectors. Module-level because ticks never nest. */
const desired = { x: 0, y: 0, z: 0 };
const away = { x: 0, y: 0, z: 0 };

/** Distance beyond which the Warden has not noticed the player yet. */
const ENGAGE_DISTANCE = 60;

/**
 * Clearance the Warden keeps from Stalkers, in metres.
 *
 * A 900 kg ally standing inside the player's melee is a 5 m wall the player cannot
 * shoot past, so the Warden shoulders its own side clear rather than being pushed.
 */
const SMALL_CLEARANCE = 3.2;

/** Seconds the enrage "announcement" lasts before normal behaviour resumes. */
const ENRAGE_ANNOUNCE_TIME = 1.1;

/** Body yaw for a look direction. Matches `forwardFromYawPitch`'s convention. */
function yawTowards(from: Vector3, to: Vector3): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

/** Writes the clamped desired velocity into the enemy. */
function commit(enemy: EnemyState, maxSpeed: number): void {
  clampSpeed(desired, maxSpeed);
  set(enemy.velocity, desired.x, desired.y, desired.z);
}

/** Stops the enemy outright. */
function halt(enemy: EnemyState): void {
  set(desired, 0, 0, 0);
  set(enemy.velocity, 0, 0, 0);
}

/**
 * Solves the straight line from the Warden's muzzle to the player's chest, **in place**.
 *
 * This is the one place the shot's geometry is decided. The AI calls it every tick of the
 * wind-up (so the warning line tracks) and the store calls nothing — it copies what this
 * produced at the instant of firing. Two properties matter:
 *
 *   - **The direction is measured from the muzzle, not from the body's centre.** The origin
 *     is pushed out to the body's surface along the aim, and the direction is then solved
 *     again from *that* point; skipping the second solve leaves the line pointing at the
 *     player from a metre to one side, which at 20 m is a visible miss of about a metre.
 *   - **The muzzle offset is derived, not a second constant.** `enemy.stats.radius` is
 *     already the body's width for collision, so "leave from the surface" needs no new
 *     number and a differently sized large enemy gets a proportionate muzzle for free.
 *
 * Exported so the geometry can be asserted directly, and so the store never has a second
 * copy of it.
 */
export function solveWardenAim(out: WardenAim, enemy: EnemyState, target: Vector3): WardenAim {
  const muzzleY = enemy.position.y + WARDEN.shotOriginHeight;
  // The player's chest rather than their feet: a line solved toward the ground plane
  // grazes the hurtbox's bottom edge and reads as passing *under* the player.
  const targetY = target.y + PLAYER.height * 0.5;

  let dx = target.x - enemy.position.x;
  let dy = targetY - muzzleY;
  let dz = target.z - enemy.position.z;
  const distance = Math.hypot(dx, dy, dz);
  if (distance < 1e-6) {
    // Degenerate (the player is standing inside the Warden). Fall back to a level shot
    // rather than producing a NaN direction that would poison every later tick.
    dx = 0;
    dy = 0;
    dz = -1;
  } else {
    dx /= distance;
    dy /= distance;
    dz /= distance;
  }

  const push = enemy.stats.radius;
  out.origin.x = enemy.position.x + dx * push;
  out.origin.y = muzzleY + dy * push;
  out.origin.z = enemy.position.z + dz * push;

  // Second solve, from the real origin. This is what makes the line the crosshair of the
  // attack: it points at the player's chest from where the bolt actually starts.
  const toX = target.x - out.origin.x;
  const toY = targetY - out.origin.y;
  const toZ = target.z - out.origin.z;
  const reach = Math.hypot(toX, toY, toZ);
  if (reach < 1e-6) {
    out.direction.x = dx;
    out.direction.y = dy;
    out.direction.z = dz;
    out.length = 0;
  } else {
    out.direction.x = toX / reach;
    out.direction.y = toY / reach;
    out.direction.z = toZ / reach;
    out.length = reach;
  }
  return out;
}

/**
 * Advances one Warden by one tick.
 *
 * @param store Read to keep clear of Stalkers. The Warden does not coordinate with
 *              them — it is an independent actor — but it does not stand inside
 *              them either.
 */
export function tickLargeWarden(enemy: EnemyState, ctx: EnemyContext, store: EnemyStore): void {
  const frame = attackFrameFor(enemy.stats);
  const distance = distanceXZ(enemy.position, ctx.playerPosition);
  // The enrage scale is the archetype's own numeric modifier, read here and
  // handed to the frame machine. It never touches `telegraphTime`.
  const cooldownScale = enemy.enraged ? ENRAGE_SCALE : 1;

  switch (enemy.fsm) {
    case 'SPAWN': {
      halt(enemy);
      enemy.view.yaw = yawTowards(enemy.position, ctx.playerPosition);
      if (enemy.stateTime >= ENEMY.turnDelay) {
        enemy.fsm = distance <= ENGAGE_DISTANCE ? 'REPOSITION' : 'IDLE';
        enemy.stateTime = 0;
      }
      break;
    }

    case 'IDLE': {
      halt(enemy);
      enemy.view.yaw = yawTowards(enemy.position, ctx.playerPosition);
      if (distance <= ENGAGE_DISTANCE) {
        enemy.fsm = 'REPOSITION';
        enemy.stateTime = 0;
      }
      break;
    }

    case 'ENRAGE': {
      // One readable beat. The Warden plants, glows, and then resumes — it does
      // not gain a new move. Keeping enrage as a *number* rather than a second
      // state machine is what stops a rebalance having to be applied twice.
      halt(enemy);
      enemy.view.lunging = true;
      enemy.view.telegraphGlow = 1;
      enemy.view.yaw = yawTowards(enemy.position, ctx.playerPosition);
      if (enemy.stateTime >= ENRAGE_ANNOUNCE_TIME) {
        enemy.view.lunging = false;
        enemy.fsm = 'REPOSITION';
        enemy.stateTime = 0;
      }
      break;
    }

    case 'REPOSITION': {
      enemy.view.yaw = yawTowards(enemy.position, ctx.playerPosition);
      enemy.view.telegraphGlow = 0;
      enemy.view.lunging = false;

      if (ctx.playerAlive && distance <= enemy.stats.attackRange && enemy.attackCooldown <= 0) {
        enemy.fsm = 'TELEGRAPH';
        enemy.stateTime = 0;
        enemy.attackElapsed = 0;
        enemy.attackResolved = false;
        enemy.shots.length = 0;
        // One emission, at the start of the wind-up. There is nothing to "lock" later:
        // the line is redrawn every tick of the wind-up and frozen when the bolt leaves,
        // which is a different fact with its own event (`enemy:shot`).
        solveWardenAim(enemy.aim, enemy, ctx.playerPosition);
        enemy.aim.active = true;
        ctx.attacks.telegraph(enemy, 'shot', ctx.time + frame.telegraphTime);
        break;
      }

      // Band hold plus a slow lateral drift, so it reads as stalking rather than
      // as a turret waiting out a cooldown.
      const strafe = Math.sin(ctx.time * WARDEN.strafeWanderRate + enemy.id) * WARDEN.strafeSpeed;
      keepDistance(
        desired,
        enemy.position,
        ctx.playerPosition,
        WARDEN.bandMin,
        WARDEN.bandMax,
        enemy.stats.moveSpeed,
        strafe,
      );
      addSmallClearance(enemy, store, enemy.stats.moveSpeed);
      commit(enemy, enemy.stats.moveSpeed);
      // Facing is resolved from the player, not from the movement direction: the
      // Warden keeps its eyes on the player while it side-steps.
      enemy.view.yaw = yawTowards(enemy.position, ctx.playerPosition);
      break;
    }

    case 'TELEGRAPH': {
      halt(enemy);
      enemy.view.lunging = true;
      enemy.view.telegraphGlow = telegraphProgress(enemy.attackElapsed, frame);
      enemy.view.yaw = yawTowards(enemy.position, ctx.playerPosition);
      // The line is re-solved every tick of the wind-up, so it tracks the player right
      // up to the instant the shot leaves. The very same call produces the values
      // `fireShot` copies below, which is why the drawn line and the bolt agree.
      solveWardenAim(enemy.aim, enemy, ctx.playerPosition);
      enemy.attackElapsed += ctx.dt;

      // Fire on the tick the wind-up ends. The shot is a straight line from here on and
      // `fireShot` freezes it: nothing in the store ever writes the direction again.
      if (!enemy.attackResolved && phaseAt(enemy.attackElapsed, frame, cooldownScale) !== 'TELEGRAPH') {
        enemy.attackResolved = true;
        enemy.aim.active = false;
        ctx.attacks.fireShot(enemy);
      }
      if (phaseAt(enemy.attackElapsed, frame, cooldownScale) !== 'TELEGRAPH') {
        enemy.fsm = 'SHOT';
        enemy.stateTime = 0;
      }
      break;
    }

    case 'SHOT': {
      // Rooted for the whole active window: the Warden committing to its own shot is the
      // player's return-fire window, and moving would make the telegraph a lie.
      //
      // The window is *not* extended until the bolt lands. That was the right rule for
      // area blasts falling on the ground around it, and the wrong one for a projectile
      // travelling away from it: the bolt is already a fact in the world, and standing
      // still for three more seconds would cost the player the fight's rhythm for no
      // readability gain. The bolt keeps flying while its owner recovers; `resolveShots`
      // runs for every live Warden regardless of this state.
      halt(enemy);
      enemy.view.lunging = true;
      enemy.view.telegraphGlow = 1;
      enemy.view.yaw = yawTowards(enemy.position, ctx.playerPosition);
      enemy.attackElapsed += ctx.dt;
      if (phaseAt(enemy.attackElapsed, frame, cooldownScale) !== 'ACTIVE') {
        enemy.fsm = 'RECOVER';
        enemy.stateTime = 0;
        enemy.view.lunging = false;
      }
      break;
    }

    case 'RECOVER': {
      halt(enemy);
      enemy.view.telegraphGlow = 0;
      enemy.view.lunging = false;
      enemy.attackElapsed += ctx.dt;
      if (phaseAt(enemy.attackElapsed, frame, cooldownScale) === 'DONE') {
        enemy.attackElapsed = 0;
        // Enrage compresses the *cooldown*, which is the other half of "faster but
        // not less fair": the player gets less time between volleys, never less
        // warning before one.
        enemy.attackCooldown = enemy.stats.attackCooldown * cooldownScale;
        enemy.fsm = 'REPOSITION';
        enemy.stateTime = 0;
      }
      break;
    }

    case 'STAGGER': {
      // The store owns the exit via `stunRemaining`. Velocity is left alone so the
      // weak-point stagger still reads as an impact.
      enemy.view.telegraphGlow = 0;
      enemy.view.lunging = false;
      break;
    }

    default: {
      halt(enemy);
      break;
    }
  }
}

/** Adds a repulsion term that keeps the Warden out of the Stalker swarm. */
function addSmallClearance(enemy: EnemyState, store: EnemyStore, speed: number): void {
  set(away, 0, 0, 0);
  let neighbours = 0;
  const range = enemy.stats.radius + SMALL_CLEARANCE;
  for (const other of store.targets) {
    if (other === enemy || !other.alive || other.kind !== 'small') continue;
    const dx = enemy.position.x - other.position.x;
    const dz = enemy.position.z - other.position.z;
    const distanceSq = dx * dx + dz * dz;
    if (distanceSq > range * range) continue;
    neighbours += 1;
    if (distanceSq < 1e-6) {
      away.x += enemy.id < other.id ? -1 : 1;
      continue;
    }
    const distance = Math.sqrt(distanceSq);
    away.x += (dx / distance) * (1 - distance / range);
    away.z += (dz / distance) * (1 - distance / range);
  }
  if (neighbours === 0) return;
  const strength = speed * ENEMY.separationStrength;
  desired.x += away.x * strength;
  desired.z += away.z * strength;
}

/**
 * The enrage cooldown scale.
 *
 * Read from config rather than declared here: a literal is exactly how "enrage
 * compresses recovery and cooldown by 0.75" would silently stop matching the
 * documented decision D-level value, and the whole enrage rule is a number.
 */
const ENRAGE_SCALE = ENRAGE_COOLDOWN_SCALE;
