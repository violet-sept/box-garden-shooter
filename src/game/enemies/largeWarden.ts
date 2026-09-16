/**
 * Large enemy AI: the Warden.
 *
 * The Warden is the heavy that **walks**. Its attack — the telegraph, the straight yellow
 * line, the freeze-at-launch, the enrage scale — lives in `heavyAttacker.ts` and is shared
 * with the gunship; what lives here is the one thing the Warden does that the gunship does
 * not: **hold an 18–26 m distance band on the ground**, drifting sideways so it reads as
 * stalking rather than as a turret waiting out a cooldown.
 *
 * Keeping the band here rather than in the shared machine is the point of the split. The
 * phase-11 brief says the gunship's attack must be "the same as the Warden's", and the
 * gunship's *movement* must not be: one flies an orbit at 11 m, the other walks a band at
 * ground level. Injecting the hold behaviour is what lets both statements be true at once
 * without either archetype carrying a branch for the other.
 *
 * Two properties of the band survive from the phase-2 design and are deliberate:
 *
 *   - **It is a band, not a chase.** The Warden is a battlefield remodeller, not a pursuer.
 *     Holding 18–26 m means it is always in the fight without ever being the thing the
 *     player has to run from, which is what keeps the small-enemy swarm the primary pressure.
 *   - **It shoulders clear of Stalkers.** A 900 kg ally standing inside the player's melee is
 *     a 5 m wall the player cannot shoot past, so the Warden pushes its own side clear rather
 *     than being pushed.
 */

import { ENEMY, WARDEN } from '../../core/config';
import { set } from '../../core/math/vec3';
import { clampSpeed, keepDistance } from './steering';
import type { EnemyState } from './EnemyState';
import type { EnemyContext, EnemyStore } from './EnemyStore';
import { tickHeavyAttacker, yawTowards } from './heavyAttacker';

/** Scratch vectors. Module-level because ticks never nest. */
const desired = { x: 0, y: 0, z: 0 };
const away = { x: 0, y: 0, z: 0 };

/**
 * Clearance the Warden keeps from Stalkers, in metres.
 *
 * A 900 kg ally standing inside the player's melee is a 5 m wall the player cannot
 * shoot past, so the Warden shoulders its own side clear rather than being pushed.
 */
const SMALL_CLEARANCE = 3.2;

/** Writes the clamped desired velocity into the enemy. */
function commit(enemy: EnemyState, maxSpeed: number): void {
  clampSpeed(desired, maxSpeed);
  set(enemy.velocity, desired.x, desired.y, desired.z);
}

/**
 * The Warden's between-shots movement: hold the band, drift, stay clear of the swarm.
 *
 * Called by `tickHeavyAttacker` only while the heavy is in `REPOSITION` and not committing
 * to a shot, which is why there is no attack decision in here.
 */
function holdBand(enemy: EnemyState, ctx: EnemyContext, store: EnemyStore, _distance: number): void {
  // Band hold plus a slow lateral drift, so it reads as stalking rather than as a turret
  // waiting out a cooldown.
  //
  // The `_distance` argument the shared machine hands over is deliberately unused: the band
  // is expressed in `keepDistance`'s own terms (a min and a max radius), and re-deriving the
  // decision from a pre-computed scalar would be a second, subtly different rule.
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
  // Facing is resolved from the player, not from the movement direction: the Warden keeps its
  // eyes on the player while it side-steps. (The shared machine already set this, but the
  // commitment is that a heavy always faces the player, so it is asserted here as well
  // rather than inherited by accident.)
  enemy.view.yaw = yawTowards(enemy.position, ctx.playerPosition);
}

/**
 * Advances one Warden by one tick.
 *
 * @param store Read to keep clear of Stalkers. The Warden does not coordinate with them —
 *              it is an independent actor — but it does not stand inside them either.
 */
export function tickLargeWarden(enemy: EnemyState, ctx: EnemyContext, store: EnemyStore): void {
  tickHeavyAttacker(enemy, ctx, store, holdBand);
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
