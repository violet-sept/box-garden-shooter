/**
 * Large enemy AI: the Warden.
 *
 * `SPAWN → IDLE → REPOSITION → TELEGRAPH → BARRAGE → RECOVER → (ENRAGE) → DEAD`.
 *
 * The archetype's whole identity is that it does not chase. It holds an 18–26 m
 * band and remodels the ground the player is standing on, so it punishes "standing
 * in the open" where the Stalker punishes "standing still". Everything below is in
 * service of two design constraints:
 *
 *   1. **The telegraph is 1.35 s and is never shortened.** It is the reaction
 *      budget, and the only thing that separates "hard" from "unfair" (brief
 *      section 1.5, hard rule 9). Enrage compresses recovery and cooldown only —
 *      `frames.ts` takes the scale as a parameter and never applies it to the
 *      telegraph, which is how that rule is enforced in code rather than in a
 *      comment.
 *   2. **The impact points are locked at the end of the telegraph and shown to the
 *      player.** A barrage that tracks the player through its wind-up is not
 *      dodgeable — only randomised — and randomised damage is the opposite of the
 *      readable rhythm the brief is built around. Locking them is also what makes
 *      `leadTarget` matter: the Warden aims where the player *will be*, so running
 *      in a straight line is punished and changing direction is rewarded.
 */

import { ENEMY, ENRAGE_COOLDOWN_SCALE, WARDEN } from '../../core/config';
import { type Vector3, distanceXZ, set } from '../../core/math/vec3';
import { phaseAt, telegraphProgress } from './frames';
import { attackFrameFor, type EnemyState } from './EnemyState';
import { clampSpeed, keepDistance, leadTarget } from './steering';
import type { EnemyContext, EnemyStore } from './EnemyStore';

/** Scratch vectors. Module-level because ticks never nest. */
const desired = { x: 0, y: 0, z: 0 };
const away = { x: 0, y: 0, z: 0 };
const aimPoint = { x: 0, y: 0, z: 0 };

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
        enemy.impactPoints.length = 0;
        enemy.blastTimers.length = 0;
        // The telegraph event carries no impact points: they do not exist yet.
        // They are locked at the *end* of the wind-up, which is the last moment the
        // player can still influence them by moving.
        ctx.attacks.telegraph(enemy, 'barrage', ctx.time + frame.telegraphTime);
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
      enemy.attackElapsed += ctx.dt;

      // Lock the impact points on the tick the wind-up ends, and publish them so
      // the player can see where not to be. The first `telegraph` call (entering
      // the wind-up) deliberately carries no points: they do not exist yet, and
      // showing markers that later move would teach the player to ignore them.
      if (!enemy.attackResolved && phaseAt(enemy.attackElapsed, frame, cooldownScale) !== 'TELEGRAPH') {
        enemy.attackResolved = true;
        lockImpactPoints(enemy, ctx);
        ctx.attacks.telegraph(enemy, 'barrage', ctx.time, enemy.impactPoints);
        ctx.attacks.scheduleBarrage(enemy, enemy.impactPoints);
      }
      if (phaseAt(enemy.attackElapsed, frame, cooldownScale) !== 'TELEGRAPH') {
        enemy.fsm = 'BARRAGE';
        enemy.stateTime = 0;
      }
      break;
    }

    case 'BARRAGE': {
      // Rooted through the whole barrage. The Warden committing to its own
      // artillery is the player's return-fire window, and moving would make the
      // telegraph a lie.
      halt(enemy);
      enemy.view.lunging = true;
      enemy.view.telegraphGlow = 1;
      enemy.view.yaw = yawTowards(enemy.position, ctx.playerPosition);
      enemy.attackElapsed += ctx.dt;
      // The blasts are timed by their own schedule, not by the window: the stagger
      // is what makes the barrage read as three separate impacts rather than one
      // wide one.
      ctx.attacks.resolveBarrage(enemy, ctx, ctx.dt);
      // The window can be extended by the schedule. Three blasts at
      // `barrageStagger` each outlast `activeTime`, and ending the state on the
      // frame-arithmetic window alone would leave the last impact unresolved —
      // i.e. warning markers that never explode, and a Warden free to reposition
      // while its own shells are still in the air.
      const scheduled = enemy.blastTimers.some((remaining) => remaining > 0);
      if (!scheduled && phaseAt(enemy.attackElapsed, frame, cooldownScale) !== 'ACTIVE') {
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

/**
 * Locks the barrage's impact points at the end of the wind-up.
 *
 * Three points, spread around the player's *predicted* position: one on it and two
 * offset, so a player who moves exactly one body-width still gets caught by an
 * edge and a player who moves decisively does not. A single point would make the
 * dodge binary — "moved or did not" — and three spread over the full radius is
 * what turns it into "moved far enough, and in a direction that was not already
 * covered".
 */
function lockImpactPoints(enemy: EnemyState, ctx: EnemyContext): void {
  leadTarget(aimPoint, ctx.playerPosition, ctx.playerVelocity, WARDEN.leadTime);
  const radius = barrageRadius(enemy);
  enemy.impactPoints.length = 0;
  const count = Math.max(1, ENEMY.barrageBlasts);
  for (let i = 0; i < count; i += 1) {
    // First blast on the predicted point, the rest evenly around a ring at 55% of
    // the blast radius. Deterministic: the same telegraph always produces the same
    // pattern, so a player can learn it.
    const angle = ((i - 1) / Math.max(1, count - 1)) * Math.PI * 2;
    const spread = i === 0 ? 0 : radius * 0.55;
    enemy.impactPoints.push({
      x: aimPoint.x + Math.sin(angle) * spread,
      y: 0,
      z: aimPoint.z + Math.cos(angle) * spread,
    });
  }
}

/**
 * Blast radius for one Warden, in metres.
 *
 * Scaled off the body radius rather than read as a flat number so a differently
 * sized large enemy automatically gets a proportionate barrage, and the tuning
 * value in `ENEMY.barrageRadius` stays expressed in the only unit that is stable
 * across archetypes (body-widths).
 */
export function barrageRadius(enemy: EnemyState): number {
  return enemy.stats.radius * ENEMY.barrageRadius;
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
