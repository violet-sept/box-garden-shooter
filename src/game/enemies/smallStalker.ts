/**
 * Small enemy AI: the Stalker.
 *
 * `SPAWN → IDLE → CHASE → TELEGRAPH → ACTIVE → RECOVER → CHASE`, plus `STAGGER`
 * (knockback or stun) and `DEAD`. The design intent is "a consumable pressure
 * source": one is trivial, a pack is not. Three things carry that intent, and all
 * three are implemented here rather than left to the caller:
 *
 *   1. **It commits.** Inside `attackRange` it stops and winds up; it does not
 *      circle. A Stalker that never commits has presence but no threat.
 *   2. **The wind-up is loud and slow enough to react to.** `telegraphTime` is
 *      0.42 s and it is never scaled — see `frames.ts`. That is the entire reason
 *      a 9 m/s archetype is fair.
 *   3. **It shares a strike budget.** Only `ATTACK_SLOTS` holders may swing; the
 *      rest keep the ring. The player's attention cost is constant no matter how
 *      many arrive.
 *
 * State bodies are plain `switch` arms over `enemy.fsm`, which is the point of an
 * FSM at this scale: every transition fits on one screen and every one of them is
 * asserted in `tests/enemies.test.ts`.
 *
 * ## Movement and speed
 *
 * The configured top speed (`moveSpeed`, 5.2) is the number the HUD, the wave
 * pacing and the difficulty are all tuned against, so it is the *ceiling* on every
 * non-attack state. `attackMoveSpeed` (9.0) is a dash-speed budget the archetype
 * spends only on the strike itself; using it to reposition would make Stalkers
 * that are *waiting* visibly faster than the ones closing in, which is backwards
 * from what the config describes.
 *
 * ## Why there is no seek-to-an-orbit-point
 *
 * An earlier revision sent each Stalker to its own point on a ring outside
 * `attackRange`, so that the ones without a slot would visibly "hold station".
 * It is worth recording why that was removed rather than tuned: an orbit point
 * that is *derived from the enemy's own current bearing* moves as the enemy moves,
 * so the pursuit never converges. The enemies chased their own moving targets
 * outward for ever, settled into a stable ring around 6.9 m, and — because 6.9 m
 * is outside `attackRange` — stopped attacking entirely after their first swing.
 * The whole encounter died in a way that looked like a throttle bug.
 *
 * The behaviour the ring was imitating falls out of the budget plus separation for
 * free: reaching the player is what earns the right to be *considered*, separation
 * spreads the ones that get there, and the budget decides which of them actually
 * swings. Nothing has to be aimed at a ring.
 */

import { ENEMY, PLAYER_HURTBOX_RADIUS } from '../../core/config';
import { type Vector3, distanceXZ, set } from '../../core/math/vec3';
import { sphereIntersectsAabb } from '../../core/math/intersect';
import { compareAttackPriority, type AttackSlots } from '../combat/damage';
import { phaseAt, telegraphProgress } from './frames';
import { attackFrameFor, type EnemyState } from './EnemyState';
import { clampSpeed, seek } from './steering';
import type { EnemyContext, EnemyStore } from './EnemyStore';

/** Scratch vectors. Module-level because ticks never nest. */
const desired = { x: 0, y: 0, z: 0 };
const away = { x: 0, y: 0, z: 0 };
const hurtbox = {
  center: { x: 0, y: 0, z: 0 },
  halfExtents: { x: 0, y: 0, z: 0 },
};
/** Turn order for the current tick, reused so nothing allocates per tick. */
const turnOrder: number[] = [];

/** Distance at which a Stalker notices the player and leaves IDLE. */
const ENGAGE_DISTANCE = 42;

/** Half-height of the player's damage capsule, metres. */
const PLAYER_HALF_HEIGHT = 0.875;

/**
 * Distance at which the final lunge stops driving forward.
 *
 * The contact test is a sphere of `radius + PLAYER_HURTBOX_RADIUS` centred on the
 * body, so contact is possible out to `attackRange + PLAYER_HURTBOX_RADIUS`. The
 * lunge therefore has to keep closing until it is comfortably inside that, or a
 * `attackRange` that is measured *between centres* would leave the enemy parked
 * exactly where its own body cannot reach. This is the "it clearly touched me"
 * margin, expressed as a distance.
 */
function lungeStopDistance(enemy: EnemyState): number {
  return enemy.stats.attackRange * 0.5;
}

/** Body yaw for a movement direction. Matches `forwardFromYawPitch`'s convention. */
function yawTowards(from: Vector3, to: Vector3): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

/** Writes the clamped desired velocity into the enemy. */
function commit(enemy: EnemyState, maxSpeed: number): void {
  clampSpeed(desired, maxSpeed);
  set(enemy.velocity, desired.x, desired.y, desired.z);
}

/** Stops the enemy outright. Used by every state that is rooted. */
function halt(enemy: EnemyState): void {
  set(desired, 0, 0, 0);
  set(enemy.velocity, 0, 0, 0);
}

/**
 * Releases a held slot.
 *
 * `completed` decides whether the enemy is credited with an attack, and the credit
 * is the rotation's fairness metric — so it must be `true` only on the normal path
 * out of RECOVER. An enemy that was killed mid-wind-up has not had its turn, and a
 * credit there would push the *pool* entry (ids survive recycling) further back
 * the next time it spawns.
 */
function releaseSlot(enemy: EnemyState, ctx: EnemyContext, completed: boolean): void {
  if (!enemy.hasAttackSlot) return;
  ctx.slots.release(enemy.id, completed);
  enemy.hasAttackSlot = false;
}

/** Enters the wind-up, having already secured a slot. */
function beginTelegraph(enemy: EnemyState, ctx: EnemyContext): void {
  const frame = attackFrameFor(enemy.stats);
  enemy.fsm = 'TELEGRAPH';
  enemy.stateTime = 0;
  enemy.attackElapsed = 0;
  enemy.attackResolved = false;
  enemy.view.lunging = true;
  ctx.attacks.telegraph(enemy, 'melee', ctx.time + frame.telegraphTime);
}

/**
 * Recomputes this tick's claim order for the attack budget.
 *
 * Called by the store once per tick, **before** any FSM runs, so every Stalker in
 * the tick is judged against the same picture. Why an order is needed at all: a
 * pack arrives together, the budget is smaller than the pack, so *who* gets a slot
 * is a real decision. Left to iteration order it is always the lowest ids, the
 * rest orbit for ever, and the encounter reads as three enemies plus scenery.
 *
 * Ordering is by "who is owed one most" ({@link compareAttackPriority}: fewest
 * prior attempts, then longest wait, then lowest id — a total order, so a seeded
 * run stays reproducible).
 */
export function beginStalkerAttackTurn(store: EnemyStore, slots: AttackSlots): void {
  turnOrder.length = 0;
  for (const enemy of store.targets) {
    if (!enemy.alive || enemy.kind !== 'small') continue;
    turnOrder.push(enemy.id);
  }
  turnOrder.sort((a, b) =>
    compareAttackPriority({ id: a, ...slots.priorityOf(a) }, { id: b, ...slots.priorityOf(b) }),
  );
}

/**
 * Claims a place in the attack budget.
 *
 * **Every** in-range Stalker calls this, not only the ones at the front of the
 * turn order, because a claim that is *refused* is what records the round-robin
 * ticket. Shortlisting first and refusing by omission looks equivalent and is not:
 * a Stalker that is never asked never accumulates priority, so it never works its
 * way forward, and the same three enemies hold the budget for the whole fight.
 *
 * The budget is still enforced — `claim` refuses once it is full and the enemy
 * keeps closing — so the turn order is a preference, not a gate.
 */
function claimAttackSlot(enemy: EnemyState, ctx: EnemyContext): boolean {
  if (ctx.slots.has(enemy.id)) return true;
  return ctx.slots.claim(enemy.id, ctx.time);
}

/**
 * Position of an enemy in the current turn order. Exposed for tests and the debug
 * panel; zero means "first in line".
 */
export function stalkerTurnPosition(id: number): number {
  return turnOrder.indexOf(id);
}

/**
 * Advances one Stalker by one tick.
 *
 * @param store Read only to enumerate neighbours for separation, which is what
 *              keeps a pack from collapsing into a single silhouette.
 */
export function tickSmallStalker(enemy: EnemyState, ctx: EnemyContext, store: EnemyStore): void {
  const frame = attackFrameFor(enemy.stats);
  const distance = distanceXZ(enemy.position, ctx.playerPosition);
  const speed = enemy.stats.moveSpeed;

  switch (enemy.fsm) {
    case 'SPAWN': {
      // A short materialisation beat: long enough that an enemy appearing behind
      // the player is not an instant hit, short enough not to read as a queue.
      halt(enemy);
      if (enemy.stateTime >= ENEMY.turnDelay) {
        enemy.fsm = distance <= ENGAGE_DISTANCE ? 'CHASE' : 'IDLE';
        enemy.stateTime = 0;
      }
      break;
    }

    case 'IDLE': {
      halt(enemy);
      if (distance <= ENGAGE_DISTANCE) {
        enemy.fsm = 'CHASE';
        enemy.stateTime = 0;
      }
      break;
    }

    case 'CHASE': {
      enemy.view.yaw = yawTowards(enemy.position, ctx.playerPosition);
      enemy.view.telegraphGlow = 0;
      enemy.view.lunging = false;

      const inRange = ctx.playerAlive && distance <= enemy.stats.attackRange && enemy.attackCooldown <= 0;
      if (inRange && claimAttackSlot(enemy, ctx)) {
        enemy.hasAttackSlot = true;
        beginTelegraph(enemy, ctx);
        break;
      }

      // Inside attack range there is nowhere to be but here. A waiting Stalker
      // plants and keeps its eyes on the player, and the separation term below
      // spreads the pack out so they are not all in the same square metre. That is
      // the "hold the ring" read, achieved without anyone steering to a ring.
      if (distance <= enemy.stats.attackRange) {
        set(desired, 0, 0, 0);
      } else {
        seek(desired, enemy.position, ctx.playerPosition, speed);
      }
      addSeparation(enemy, store, speed);
      commit(enemy, speed);
      break;
    }

    case 'TELEGRAPH': {
      // Rooted. Movement during the wind-up would make the telegraph unreadable,
      // which is the one thing it exists to be.
      halt(enemy);
      enemy.view.telegraphGlow = telegraphProgress(enemy.attackElapsed, frame);
      enemy.view.lunging = true;
      enemy.view.yaw = yawTowards(enemy.position, ctx.playerPosition);
      enemy.attackElapsed += ctx.dt;
      // The phase check happens *after* the clock advances, so a window is never
      // skipped at a low tick rate: `TELEGRAPH` is only ever entered on a tick,
      // and the phase it lands in is decided by elapsed time, not by a count.
      if (phaseAt(enemy.attackElapsed, frame) !== 'TELEGRAPH') {
        enemy.fsm = 'ACTIVE';
        enemy.stateTime = 0;
      }
      break;
    }

    case 'ACTIVE': {
      enemy.attackElapsed += ctx.dt;
      // The contact test runs on every tick of the window, not once at its opening
      // edge. The swing is a pounce: the enemy spends the window closing, and a
      // single test on the first tick would resolve before it had arrived — the
      // "it clearly touched me and nothing happened" failure. `attackResolved`
      // latches the moment it does connect, so one swing still lands at most once.
      if (!enemy.attackResolved && ctx.playerAlive && contactHitsPlayer(enemy, ctx)) {
        enemy.attackResolved = true;
        ctx.attacks.melee(enemy, enemy.stats.damage);
      }
      // The lunge: a short burst forward, spending the archetype's dash budget.
      // Rooted at the ring is the telegraph; a body that also freezes through the
      // strike itself reads as a dropped frame rather than as a pounce.
      set(enemy.velocity, 0, 0, 0);
      if (distance > lungeStopDistance(enemy)) {
        seek(desired, enemy.position, ctx.playerPosition, enemy.stats.attackMoveSpeed);
        commit(enemy, enemy.stats.attackMoveSpeed);
      }
      enemy.view.telegraphGlow = 1;
      if (phaseAt(enemy.attackElapsed, frame) !== 'ACTIVE') {
        enemy.fsm = 'RECOVER';
        enemy.stateTime = 0;
        enemy.view.lunging = false;
      }
      break;
    }

    case 'RECOVER': {
      // The player's window, and clearly so: this is the beat that makes
      // "back off, then punish" a learnable loop.
      halt(enemy);
      enemy.view.telegraphGlow = 0;
      enemy.view.lunging = false;
      enemy.attackElapsed += ctx.dt;
      if (phaseAt(enemy.attackElapsed, frame) === 'DONE') {
        // A full attack: this is the one path that credits the rotation.
        releaseSlot(enemy, ctx, true);
        enemy.attackElapsed = 0;
        // Cooldown is measured from the end of recovery, which is what makes the
        // configured value mean "gap between attacks" rather than "gap between the
        // start of the wind-up and the next one".
        enemy.attackCooldown = enemy.stats.attackCooldown;
        enemy.fsm = 'CHASE';
        enemy.stateTime = 0;
      }
      break;
    }

    case 'STAGGER': {
      // Velocity is deliberately left alone: the knockback impulse is already in
      // it, and zeroing here would cancel the very push the hit was meant to give.
      // The store owns the exit from this state, via `stunRemaining`.
      enemy.view.telegraphGlow = 0;
      enemy.view.lunging = false;
      break;
    }

    default: {
      halt(enemy);
      break;
    }
  }

  keepOutOfPlayer(enemy, ctx, speed);
}

/** Sphere-versus-box contact between a Stalker's swing and the player's capsule. */
function contactHitsPlayer(enemy: EnemyState, ctx: EnemyContext): boolean {
  hurtbox.center.x = ctx.playerPosition.x;
  hurtbox.center.y = ctx.playerPosition.y + PLAYER_HALF_HEIGHT;
  hurtbox.center.z = ctx.playerPosition.z;
  hurtbox.halfExtents.x = PLAYER_HURTBOX_RADIUS;
  hurtbox.halfExtents.y = PLAYER_HALF_HEIGHT;
  hurtbox.halfExtents.z = PLAYER_HURTBOX_RADIUS;
  // The enemy's reach is a sphere at its own centre, expanded to its radius. The
  // overlap test is deliberately forgiving: "it clearly reached me and nothing
  // happened" costs more trust than a swing that only nearly connected.
  const reach = enemy.stats.radius + PLAYER_HURTBOX_RADIUS;
  const center = { x: enemy.position.x, y: enemy.position.y + enemy.stats.height * 0.5, z: enemy.position.z };
  return sphereIntersectsAabb(center, reach, hurtbox);
}

/** Adds the neighbour-repulsion term to the current desired velocity. */
function addSeparation(enemy: EnemyState, store: EnemyStore, speed: number): void {
  set(away, 0, 0, 0);
  let neighbours = 0;
  const range = enemy.stats.radius * ENEMY.separationRadiusScale * 2;
  for (const other of store.targets) {
    if (other === enemy || !other.alive || other.kind === 'dummy') continue;
    const dx = enemy.position.x - other.position.x;
    const dz = enemy.position.z - other.position.z;
    const distanceSq = dx * dx + dz * dz;
    if (distanceSq > range * range) continue;
    neighbours += 1;
    if (distanceSq < 1e-6) {
      // Deterministic tie-break: the lower id always yields toward -X, so a seeded
      // run separates the same way every time.
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
 * Keeps a Stalker from standing inside the player.
 *
 * Not cosmetic: without it, two enemies converging on the same point end up
 * inside the camera, and the player's view is filled by a torso.
 */
function keepOutOfPlayer(enemy: EnemyState, ctx: EnemyContext, speed: number): void {
  const dx = enemy.position.x - ctx.playerPosition.x;
  const dz = enemy.position.z - ctx.playerPosition.z;
  const minimum = enemy.stats.radius + PLAYER_HURTBOX_RADIUS;
  const distanceSq = dx * dx + dz * dz;
  if (distanceSq >= minimum * minimum) return;
  if (distanceSq < 1e-6) {
    enemy.position.x += minimum;
    return;
  }
  const distance = Math.sqrt(distanceSq);
  const push = (minimum - distance) * speed;
  enemy.velocity.x += (dx / distance) * push;
  enemy.velocity.z += (dz / distance) * push;
}
