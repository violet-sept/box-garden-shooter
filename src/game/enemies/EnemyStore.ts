/**
 * The enemy repository.
 *
 * Phase 1 shipped `game/targets.ts`: a store of static practice dummies that
 * already had the shape the shot resolver wanted. This is that store, evolved
 * (route A of the stage-2 brief section 3.2) rather than a second parallel one.
 * The reason is not tidiness — a second repository means two copies of the hitbox
 * rebuild and a `hitscan` that has to query both, and the first thing that breaks
 * when you query two lists is the distance ordering that keeps a 5 m crate in
 * front of a 9 m enemy.
 *
 * What lives here:
 *   - practice dummies (`kind: 'dummy'`), which keep phase 1's tuning baseline
 *     reachable and let the existing whole-world tests keep their assertions;
 *   - live enemies (`kind: 'small' | 'large' | 'helicopter'`), with an FSM, an attack clock
 *     and the shared `ATTACK_SLOTS` budget. The two heavies share one attack machine
 *     (`heavyAttacker.ts`) and differ only in how they move between shots;
 *   - spawning from an **injected position**, which is the interface phase 3's spawn-point
 *     filter needs (brief section 1.7): an enemy never chooses where to appear. The one
 *     archetype-level exception is that a **flying** body is placed at its altitude rather
 *     than at the ground point the caller passed, because every spawn point the director can
 *     produce is a ground position by construction.
 *
 * Allocation discipline: entries are pooled per archetype and recycled, because a
 * script that releases ten enemies in a single tick must not allocate ten bodies per
 * drop for the whole run.
 *
 * ## Tick order inside `tick`
 *
 *   1. Release the slots of anything that died (idempotent, and cheap).
 *   2. Advance every live enemy's FSM and move its body.
 *   3. Rebuild every hitbox from the *new* position.
 *
 * Step 3 is not optional and not deferrable to the later `sync`: the shot for this
 * tick is resolved after `tick` returns, so an enemy that moved without rebuilding
 * its hitboxes would be hit where it used to be — the "moving targets always miss
 * by a little" failure from the stage-2 trap table. `sync` then re-runs it, which
 * is idempotent, purely so the practice dummies (which have no AI) and any enemy
 * that did not move are covered by one uniform pass.
 */

import {
  ATTACK_SLOTS,
  ENEMY,
  ENEMY_DUMMY,
  ENRAGE_HEALTH_FRACTION,
  HELICOPTER,
  PLAYER,
  PLAYER_HURTBOX_RADIUS,
  SIM,
  WARDEN,
  type EnemyArchetypeId,
  type EnemyStats,
} from '../../core/config';
import type { EventSink, HitZone } from '../../core/events';
import { type Vector3, copy, set } from '../../core/math/vec3';
import { createRayHit, rayAabb, segmentIntersectsAabb } from '../../core/math/intersect';
import { buildHitboxes, syncHitboxes } from '../combat/hitboxes';
import { createAttackSlots, resolveKnockback, type AttackSlots } from '../combat/damage';
import type { CollisionWorld } from '../player/player';
import type { TargetSpec } from '../level';
import {
  createViewState,
  createWardenAim,
  isFlying,
  isHeavy,
  statsFor,
  type EnemyKind,
  type EnemyState,
  type EnemyStateName,
  type WardenShot,
} from './EnemyState';
import { tickHelicopter } from './helicopter';
import { tickLargeWarden } from './largeWarden';
import { tickSmallStalker, beginStalkerAttackTurn } from './smallStalker';

/** A blast request produced by an AI module and resolved by the store. */
export interface BlastRequest {
  readonly ownerId: number;
  readonly position: Vector3;
  readonly radius: number;
  readonly damage: number;
}

/**
 * Scratch for the per-tick shot sweep.
 *
 * Module-level for the same reason `steering.ts` keeps its own: ticks never nest, and the
 * phase-4 rule that a simulation tick allocates nothing is easier to hold when the shapes
 * are declared once. `shotHurtbox` is the inflated player box, rewritten in place for every
 * shot test.
 */
const shotHit = createRayHit();
const shotFrom = { x: 0, y: 0, z: 0 };
const shotHurtbox = {
  center: { x: 0, y: 0, z: 0 },
  halfExtents: { x: 0, y: 0, z: 0 },
};

/**
 * How an enemy's attack reaches the player.
 *
 * Injected into the AI modules rather than handed a `World`, so the archetype
 * modules stay pure state machines: they decide *when* and *where* an attack
 * lands, and the store owns the resolution. It also means an AI unit test can
 * pass a recording sink and assert what an attack produced without building a
 * world at all.
 */
export interface EnemyAttackSink {
  /** Announces a wind-up so the presentation layer can light it up. */
  telegraph(enemy: EnemyState, kind: 'melee' | 'shot', until: number): void;
  /**
   * Resolves a contact melee swing against the player's damage capsule.
   *
   * Uses sphere-against-box overlap rather than a ray: a ray can slip past a body
   * that visibly touched the enemy, and "it clearly reached me and nothing
   * happened" reads as a broken hitbox. Returns true when it connected.
   */
  melee(enemy: EnemyState, damage: number): boolean;
  /**
   * Freezes the Warden's current aim line into a projectile.
   *
   * Called at the end of the wind-up, and it copies: after this returns, nothing ever
   * writes the shot's direction again, which is what "the path does not change once it
   * is fired" means as code. The flight and the hit test are the store's, not the AI's —
   * `resolveShots` runs for every live Warden whatever state its FSM is in.
   */
  fireShot(enemy: EnemyState): void;
}

/** What the AI modules need to know about the world this tick. */
export interface EnemyContext {
  readonly playerPosition: Vector3;
  readonly playerVelocity: Vector3;
  readonly playerAlive: boolean;
  readonly time: number;
  readonly dt: number;
  /** Melee budget shared by every small enemy. */
  readonly slots: AttackSlots;
  /** Solid level geometry, for keeping enemies out of crates. */
  readonly collision: CollisionWorld;
  /** Resolution hooks for the attacks the FSMs decide to perform. */
  readonly attacks: EnemyAttackSink;
}

/** Optional overrides when spawning. */
export interface SpawnOptions {
  /** Starting state. Defaults to `SPAWN`. */
  readonly state?: 'SPAWN' | 'IDLE';
}

/** Public surface of the enemy repository. */
export interface EnemyStore {
  /**
   * Every entry, dummies included.
   *
   * Named `targets` rather than `enemies` on purpose: this is the array the shot
   * resolver already reads, and renaming it would be churn in the phase-1
   * integration tests for no behavioural gain.
   */
  readonly targets: readonly EnemyState[];
  /** Melee budget, exposed so tests and the debug panel can read the limit. */
  readonly attackSlots: AttackSlots;
  /**
   * The attack resolver the AI modules use.
   *
   * On the public surface because `World` has to place it in the per-tick
   * `EnemyContext`, which it builds itself. It is not intended to be called from
   * gameplay code: `melee()` resolves one swing and knows nothing about whether the
   * enemy was allowed to swing, so calling it directly would bypass the FSM.
   */
  readonly attacks: EnemyAttackSink;

  /** Advances every enemy FSM and moves the bodies. Call before the shot resolves. */
  tick(ctx: EnemyContext): void;
  /** Rebuilds hitboxes and animates the practice dummies. Call before the shot. */
  sync(dt: number, time: number): void;

  byId(id: number): EnemyState | undefined;
  /** Creates a live enemy at an injected position. */
  spawn(archetype: EnemyArchetypeId, position: Vector3, options?: SpawnOptions): EnemyState;
  /** Marks an enemy dead, releases its slot and recycles it. Safe to call twice. */
  despawn(enemy: EnemyState): void;
  /** Applies damage, emits events, returns the enemy that died if any. */
  applyDamage(enemy: EnemyState, amount: number, zone: HitZone, point: Vector3, direction?: Vector3): EnemyState | null;
  /** Resolves one blast against everything inside it. Returns how many it hit. */
  applyBlast(request: BlastRequest): number;

  aliveCount(): number;
  /** Live combatants only: practice dummies are excluded from the run's bookkeeping. */
  liveCount(kind?: EnemyKind): number;
  damagedCount(): number;
  reset(): void;
}

/** Dummy bookkeeping: the level spec drives the bob and the reset position. */
interface DummyRecord {
  readonly spec: TargetSpec;
  readonly enemy: EnemyState;
  /**
   * The dummy's own maximum health, captured at construction.
   *
   * Kept separately because a dummy can be shot (it is a live body in the store) and its
   * health is restored on `reset()`; reading the maximum back off `enemy.stats` would be
   * reading a value the damage path has already written to.
   */
  readonly maxHealth: number;
}

/** One archetype's free list. */
type Pool = Map<EnemyKind, EnemyState[]>;

/**
 * Creates the stat block for one spawned body.
 *
 * A **copy** per body rather than the shared archetype object: `enemy.stats` is `readonly`
 * on the state, the HUD and the damage numbers read it, and the render layer may hold a
 * reference to it — so one body must never be able to alias the table. The pool keeps the
 * copy, so a recycled body reuses its object.
 *
 * There used to be a `healthScale` parameter here, for the phase-3 wave curve's per-wave
 * health ramp. Phase 10's script gives every Stalker in a run the same numbers, so the
 * scale became a parameter that could only ever be 1 and was deleted along with the curve.
 */
function bodyStats(base: EnemyStats): EnemyStats {
  return { ...base };
}

function makeEnemy(id: number, kind: EnemyKind, stats: EnemyStats): EnemyState {
  const position = { x: 0, y: 0, z: 0 };
  return {
    id,
    kind,
    stats,
    weakPointMultiplier: stats.headshotMultiplier,
    hitboxes: buildHitboxes(stats, position),
    position,
    velocity: { x: 0, y: 0, z: 0 },
    previousPosition: { x: 0, y: 0, z: 0 },
    fsm: 'SPAWN',
    stateTime: 0,
    attackElapsed: 0,
    attackCooldown: 0,
    hasAttackSlot: false,
    attackResolved: false,
    health: stats.maxHealth,
    alive: true,
    lastHitTime: -Infinity,
    totalDamageTaken: 0,
    lastKnockbackTime: -Infinity,
    stunRemaining: 0,
    lastRepathTime: -Infinity,
    enraged: false,
    weakPointDamageSinceStagger: 0,
    aim: createWardenAim(),
    shots: [],
    view: createViewState(),
  };
}

/** Resets every mutable field so a recycled entry is a genuine fresh start. */
function resetEnemy(enemy: EnemyState, health: number): void {
  enemy.fsm = 'SPAWN';
  enemy.stateTime = 0;
  enemy.attackElapsed = 0;
  enemy.attackCooldown = 0;
  enemy.hasAttackSlot = false;
  enemy.attackResolved = false;
  enemy.health = health;
  enemy.alive = true;
  enemy.lastHitTime = -Infinity;
  enemy.totalDamageTaken = 0;
  enemy.lastKnockbackTime = -Infinity;
  enemy.stunRemaining = 0;
  enemy.lastRepathTime = -Infinity;
  enemy.enraged = false;
  enemy.weakPointDamageSinceStagger = 0;
  enemy.aim.active = false;
  enemy.aim.length = 0;
  enemy.shots.length = 0;
  set(enemy.velocity, 0, 0, 0);
  enemy.view.yaw = 0;
  enemy.view.telegraphGlow = 0;
  enemy.view.hitFlash = 0;
  enemy.view.lunging = false;
}

/**
 * Whether incoming fire is allowed to interrupt the current state.
 *
 * Deliberately false during TELEGRAPH, ACTIVE and RECOVER. Cancelling a wind-up
 * that the player is already reacting to removes the only cue they had — the same
 * fairness rule that forbids shortening the telegraph. Interrupting the *idle*
 * states is free, and that is what makes sustained fire on a Stalker feel like it
 * has weight.
 */
function stateCanBeInterrupted(state: EnemyStateName): boolean {
  return state === 'SPAWN' || state === 'IDLE' || state === 'CHASE' || state === 'REPOSITION' || state === 'ENRAGE';
}

/** Height of the highest surface an enemy is standing on, at its own footprint. */
function groundHeight(enemy: EnemyState, world: CollisionWorld): number {
  const { position, stats } = enemy;
  let best = 0;
  for (const box of world.obstacles) {
    const overlapX = box.halfExtents.x + stats.radius - Math.abs(position.x - box.center.x);
    if (overlapX <= 0) continue;
    const overlapZ = box.halfExtents.z + stats.radius - Math.abs(position.z - box.center.z);
    if (overlapZ <= 0) continue;
    const top = box.center.y + box.halfExtents.y;
    if (top <= best) continue;
    // The step budget is shared with the player controller: an enemy walks onto a
    // 0.4 m kerb rather than pressing against it for ever, but is never teleported
    // onto a 3 m platform it was standing beside.
    if (top - position.y > PLAYER.stepHeight) continue;
    best = top;
  }
  return best;
}

/** Pushes an enemy out of level geometry along the shallowest axis. */
function resolveEnemyCollision(enemy: EnemyState, world: CollisionWorld): void {
  const { position, stats } = enemy;
  const centerY = position.y + stats.height * 0.5;
  for (const box of world.obstacles) {
    const overlapX = box.halfExtents.x + stats.radius - Math.abs(position.x - box.center.x);
    if (overlapX <= 0) continue;
    const overlapZ = box.halfExtents.z + stats.radius - Math.abs(position.z - box.center.z);
    if (overlapZ <= 0) continue;
    const overlapY = box.halfExtents.y + stats.height * 0.5 - Math.abs(centerY - box.center.y);
    if (overlapY <= 0) continue;
    if (overlapX <= overlapZ) {
      const sign = position.x < box.center.x ? -1 : 1;
      position.x += overlapX * sign;
      if (Math.sign(enemy.velocity.x) === sign) enemy.velocity.x = 0;
    } else {
      const sign = position.z < box.center.z ? -1 : 1;
      position.z += overlapZ * sign;
      if (Math.sign(enemy.velocity.z) === sign) enemy.velocity.z = 0;
    }
  }
}

/**
 * Creates the enemy store for a level.
 *
 * Practice dummies and live enemies share one array and one `id` space, so the
 * shot resolver's "nearest hit wins" comparison covers everything shootable, and
 * a later spawn can never collide with a dummy's id.
 */
export function createEnemyStore(dummySpecs: readonly TargetSpec[], events: EventSink): EnemyStore {
  const dummies: DummyRecord[] = [];
  const entries: EnemyState[] = [];
  const pool: Pool = new Map();
  const lookup = new Map<number, EnemyState>();
  const indexById = new Map<number, number>();

  let nextId = 1;
  let tick = 0;

  for (const spec of dummySpecs) {
    // The dummy's collision geometry comes from the level spec (phase 1 authored
    // it to match the meshes) while its behaviour comes from the shared stat
    // block. Spreading and overriding keeps one source of truth per field.
    const stats: EnemyStats = {
      ...ENEMY_DUMMY,
      radius: spec.bodyRadius,
      height: spec.bodyHeight + spec.headRadius * 2,
      maxHealth: spec.health,
    };
    const enemy = makeEnemy(nextId, 'dummy', stats);
    nextId += 1;
    set(enemy.position, spec.base.x, spec.base.y, spec.base.z);
    syncHitboxes(enemy.hitboxes, stats, enemy.position);
    dummies.push({ spec, enemy, maxHealth: stats.maxHealth });
    entries.push(enemy);
    lookup.set(enemy.id, enemy);
    indexById.set(enemy.id, entries.length - 1);
  }

  const slots = createAttackSlots(ATTACK_SLOTS);
  const separation = { x: 0, y: 0, z: 0 };

  /** Rebuilds the id → index map from `from` onward. */
  const reindex = (from: number): void => {
    for (let i = from; i < entries.length; i += 1) {
      const enemy = entries[i];
      if (enemy) indexById.set(enemy.id, i);
    }
  };

  /** Removes an entry and returns it to its pool. */
  const retire = (enemy: EnemyState): void => {
    const index = indexById.get(enemy.id);
    if (index === undefined) return;
    // Swap-with-last keeps removal O(1). Order inside `entries` carries no
    // meaning — nothing iterates it positionally — and the swap is deterministic,
    // so a seeded run still produces the same sequence every time.
    const last = entries.pop();
    if (last && index < entries.length) entries[index] = last;
    indexById.delete(enemy.id);
    lookup.delete(enemy.id);
    reindex(index);
    if (enemy.kind === 'dummy') return;
    const free = pool.get(enemy.kind);
    if (free) free.push(enemy);
    else pool.set(enemy.kind, [enemy]);
  };

  /**
   * Releases a held slot without crediting a completed attack.
   *
   * Every caller here is an abort: the enemy died, or a stun interrupted it before
   * its strike landed. Crediting an abort would reward dying, and because ids
   * survive pooling, the credit would follow the entry into its next life and push
   * that slot to the back of the rotation for ever.
   */
  const releaseSlot = (enemy: EnemyState): void => {
    if (!enemy.hasAttackSlot) return;
    slots.release(enemy.id, false);
    enemy.hasAttackSlot = false;
  };

  /**
   * The attack resolver handed to the AI modules.
   *
   * It publishes damage rather than applying it: `player:damaged` is emitted and
   * the world decides what happens, because i-frames, health clamping and death
   * belong to the player, not to the enemy that swung. Reaching across would also
   * put a dependency from the enemy layer into the player layer that the phase-1
   * architecture deliberately does not have.
   */
  const attacks: EnemyAttackSink = {
    telegraph(enemy, kind, until) {
      events.emit('enemy:telegraph', {
        tick,
        id: enemy.id,
        archetype: enemy.kind === 'dummy' ? 'small' : enemy.kind,
        kind,
        until,
      });
    },

    melee(enemy, damage) {
      events.emit('player:damaged', {
        tick,
        amount: damage,
        from: { x: enemy.position.x, y: enemy.position.y, z: enemy.position.z },
        source: 'melee',
      });
      return true;
    },

    fireShot(enemy) {
      // The one and only write of a shot's direction. `enemy.aim` was solved by
      // `solveWardenAim` on this same tick, so the bolt follows the line the player was
      // just shown; from here on it is a point moving along a frozen vector.
      const aim = enemy.aim;
      const shot: WardenShot = {
        origin: { x: aim.origin.x, y: aim.origin.y, z: aim.origin.z },
        direction: { x: aim.direction.x, y: aim.direction.y, z: aim.direction.z },
        position: { x: aim.origin.x, y: aim.origin.y, z: aim.origin.z },
        travelled: 0,
        alive: true,
      };
      enemy.shots.push(shot);
      events.emit('enemy:shot', {
        tick,
        enemyId: enemy.id,
        origin: { x: shot.origin.x, y: shot.origin.y, z: shot.origin.z },
        direction: { x: shot.direction.x, y: shot.direction.y, z: shot.direction.z },
      });
    },
  };

  /**
   * Whether this tick's travel crosses the player's damage box.
   *
   * The box is the one the melee path uses (`PLAYER_HURTBOX_RADIUS` wide and `PLAYER.height`
   * tall), **inflated by the shot's own radius**: the Minkowski sum of the two shapes, i.e.
   * "did a 0.85 m bolt touch the body" rather than "did the bolt's centre pass through the
   * chest". Inflating the box is exact for a sphere and costs no square roots.
   */
  const shotCrossesPlayer = (from: Vector3, to: Vector3, playerPosition: Vector3): boolean => {
    shotHurtbox.center.x = playerPosition.x;
    shotHurtbox.center.y = playerPosition.y + PLAYER.height * 0.5;
    shotHurtbox.center.z = playerPosition.z;
    shotHurtbox.halfExtents.x = PLAYER_HURTBOX_RADIUS + WARDEN.shotRadius;
    shotHurtbox.halfExtents.y = PLAYER.height * 0.5 + WARDEN.shotRadius;
    shotHurtbox.halfExtents.z = PLAYER_HURTBOX_RADIUS + WARDEN.shotRadius;
    return segmentIntersectsAabb(from, to, shotHurtbox);
  };

  /**
   * Advances one enemy's shots and resolves whatever their lines end on.
   *
   * Deliberately **not** part of the FSM. A bolt is a fact in the world from the instant it
   * is fired: it keeps flying while its owner recovers, repositions, is staggered or even
   * dies, so this runs for every live heavy on every tick regardless of what its state
   * machine is doing. Tying it to the `SHOT` state (the phase-2 rule for area blasts) would
   * have left the projectile frozen in mid-air the moment its owner walked away from it.
   *
   * Each tick is a **swept** test, not a point sample: at 24 m/s the shot covers 0.4 m per
   * tick, and a point test would let it pass through a player between two ticks — the
   * classic fast-projectile tunnelling miss, which the player reads as "it clearly went
   * through me and nothing happened".
   *
   * It damages **the player only**. The area barrage this replaced also caught Stalkers
   * (bombing the swarm was a legitimate play); a bolt does not, because a line that
   * silently kills the enemies around the player would make "drag the pack onto the line"
   * a strategy the attack's own visual language does not describe.
   */
  const resolveShots = (enemy: EnemyState, ctx: EnemyContext, dt: number): void => {
    for (const shot of enemy.shots) {
      if (!shot.alive) continue;
      const step = WARDEN.shotSpeed * dt;
      set(shotFrom, shot.position.x, shot.position.y, shot.position.z);

      // How far this tick's travel gets before it meets cover. The nearest solid wins, so a
      // shot is stopped by the first crate on its line rather than by whichever one the
      // level happens to list last.
      let blockedAt = Infinity;
      for (const box of ctx.collision.solids) {
        const hit = rayAabb(shotHit, shot.position, shot.direction, box);
        if (!hit) continue;
        if (hit.inside) {
          blockedAt = 0;
          break;
        }
        if (hit.t > 0 && hit.t < blockedAt) blockedAt = hit.t;
      }

      const travel = Math.min(step, blockedAt);
      shot.position.x += shot.direction.x * travel;
      shot.position.y += shot.direction.y * travel;
      shot.position.z += shot.direction.z * travel;
      shot.travelled += travel;

      // The player is tested against the same shortened segment, so a body behind a crate
      // cannot be hit through it — cover has to work against this attack or it is not cover.
      if (ctx.playerAlive && shotCrossesPlayer(shotFrom, shot.position, ctx.playerPosition)) {
        shot.alive = false;
        events.emit('enemy:shotEnded', {
          tick,
          enemyId: enemy.id,
          position: { x: shot.position.x, y: shot.position.y, z: shot.position.z },
          radius: WARDEN.shotRadius,
          hitPlayer: true,
        });
        // Published as an ordinary damage request so i-frames apply to a shot exactly as
        // they do to a swipe: one rule, and in one place. The damage is the archetype's
        // configured value with no falloff — the shot either crossed the body or it did not.
        events.emit('player:damaged', {
          tick,
          amount: enemy.stats.damage,
          from: { x: shot.position.x, y: shot.position.y, z: shot.position.z },
          source: 'shot',
        });
        continue;
      }

      if (blockedAt <= step) {
        shot.alive = false;
        events.emit('enemy:shotEnded', {
          tick,
          enemyId: enemy.id,
          position: { x: shot.position.x, y: shot.position.y, z: shot.position.z },
          radius: WARDEN.shotRadius,
          hitPlayer: false,
        });
        continue;
      }

      if (shot.travelled >= WARDEN.shotRange) {
        // Out of range: retired silently. There is nothing out there to flash, and a bolt
        // vanishing at the far edge of the arena is not information the player needs.
        shot.alive = false;
      }
    }
  };

  /** Applies velocity, resolves collisions, separates from neighbours. */
  const integrate = (enemy: EnemyState, ctx: EnemyContext): void => {
    const { position, velocity, stats } = enemy;
    const world = ctx.collision;

    /**
     * Flying bodies are integrated differently, and the difference is the point of them.
     *
     * A gunship holds its own altitude: it does **not** ground-snap (the vertical axis is a
     * velocity there, not a solve), it does not get pushed out of level geometry (nothing in
     * the arena is taller than the 6.4 m fence, so at `HELICOPTER.altitude` there is nothing
     * to be pushed out of), and it does not separate from other enemies (there is exactly one
     * gunship per run, and it is eleven metres above whatever else is on the field). What
     * survives is the arena clamp: it can fly far, but not out of the box garden.
     */
    if (isFlying(enemy.kind)) {
      position.x += velocity.x * ctx.dt;
      position.y += velocity.y * ctx.dt;
      position.z += velocity.z * ctx.dt;
      const bound = world.halfSize - stats.radius;
      position.x = position.x > bound ? bound : position.x < -bound ? -bound : position.x;
      position.z = position.z > bound ? bound : position.z < -bound ? -bound : position.z;
      return;
    }

    position.x += velocity.x * ctx.dt;
    resolveEnemyCollision(enemy, world);
    position.z += velocity.z * ctx.dt;
    resolveEnemyCollision(enemy, world);
    // A second pass for the inside-corner case where resolving X pushes the
    // capsule into a box the Z pass had already cleared — the same reason the
    // player controller runs one.
    resolveEnemyCollision(enemy, world);

    // Enemies do not jump and there is no vertical velocity to integrate, so the
    // vertical axis is a snap to the highest surface under the feet.
    position.y = groundHeight(enemy, world);

    const limit = world.halfSize - stats.radius;
    position.x = position.x > limit ? limit : position.x < -limit ? -limit : position.x;
    position.z = position.z > limit ? limit : position.z < -limit ? -limit : position.z;

    // Separation is a position correction, not a force: two enemies can never end
    // a tick overlapping, which is what makes "they never stand inside each other"
    // observable from outside rather than a claim about the integrator.
    set(separation, 0, 0, 0);
    for (const other of entries) {
      if (other === enemy || !other.alive) continue;
      const dx = position.x - other.position.x;
      const dz = position.z - other.position.z;
      const range = (stats.radius + other.stats.radius) * ENEMY.separationRadiusScale;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq >= range * range) continue;
      if (distanceSq < 1e-6) {
        // Deterministic tie-break, so a seeded run is reproducible: the lower id
        // always moves toward -X.
        separation.x += enemy.id < other.id ? -range : range;
        continue;
      }
      const distance = Math.sqrt(distanceSq);
      const overlap = range - distance;
      separation.x += (dx / distance) * overlap;
      separation.z += (dz / distance) * overlap;
    }
    if (separation.x !== 0 || separation.z !== 0) {
      // Half the overlap each, so the pair separates symmetrically and neither is
      // privileged by iteration order.
      position.x += separation.x * 0.5;
      position.z += separation.z * 0.5;
      resolveEnemyCollision(enemy, world);
    }
  };

  const advance = (enemy: EnemyState, ctx: EnemyContext): void => {
    enemy.stateTime += ctx.dt;
    enemy.attackCooldown = Math.max(0, enemy.attackCooldown - ctx.dt);

    // Shots fly whatever the owner is doing — stunned, recovering, repositioning or dead —
    // which is why this is here rather than inside the archetype's FSM. It runs before the
    // FSM so a bolt fired on this tick has moved by the time the render layer reads it, and
    // so "where the player is" and "whether the line crossed them" describe one world state.
    if (isHeavy(enemy.kind)) resolveShots(enemy, ctx, ctx.dt);

    if (enemy.stunRemaining > 0) {
      enemy.stunRemaining = Math.max(0, enemy.stunRemaining - ctx.dt);
      // A stunned enemy still slides from the knockback impulse; it just cannot
      // act. Freezing its position as well would make hitstun read as a network
      // stall rather than as an impact.
      integrate(enemy, ctx);
      if (enemy.stunRemaining === 0) {
        enemy.fsm = enemy.kind === 'small' ? 'CHASE' : 'REPOSITION';
        enemy.stateTime = 0;
      }
      return;
    }

    if (enemy.kind === 'small') tickSmallStalker(enemy, ctx, store);
    else if (enemy.kind === 'large') tickLargeWarden(enemy, ctx, store);
    else if (enemy.kind === 'helicopter') tickHelicopter(enemy, ctx, store);
    integrate(enemy, ctx);
  };
  const store: EnemyStore = {
    targets: entries,
    attackSlots: slots,
    attacks,

    tick(ctx) {
      // 1. Anything that died last tick gives its slot back before anyone asks.
      for (const enemy of entries) {
        if (!enemy.alive) releaseSlot(enemy);
      }
      // 2. Advance. Dummies have no AI and are skipped entirely.
      //    The attack-slot turn order is fixed *before* any FSM runs, so the
      //    outcome does not depend on which enemy the loop happens to reach first.
      beginStalkerAttackTurn(store, slots);
      for (const enemy of entries) {
        if (!enemy.alive || enemy.kind === 'dummy') continue;
        copy(enemy.previousPosition, enemy.position);
        advance(enemy, ctx);
      }
      // 3. Rebuild from the new positions, before the shot is resolved.
      for (const enemy of entries) {
        if (!enemy.alive) continue;
        syncHitboxes(enemy.hitboxes, enemy.stats, enemy.position);
      }
    },

    sync(dt, time) {
      for (const dummy of dummies) {
        const { spec, enemy } = dummy;
        if (!enemy.alive) {
          set(enemy.velocity, 0, 0, 0);
          continue;
        }
        if (spec.bobAmplitude > 0 && spec.bobHz > 0) {
          const omega = spec.bobHz * Math.PI * 2;
          enemy.position.x = spec.base.x + Math.sin(time * omega) * spec.bobAmplitude;
          enemy.velocity.x = Math.cos(time * omega) * spec.bobAmplitude * omega;
          enemy.position.y = spec.base.y;
          enemy.position.z = spec.base.z;
          enemy.velocity.y = 0;
          enemy.velocity.z = 0;
        } else {
          copy(enemy.position, spec.base);
          set(enemy.velocity, 0, 0, 0);
        }
        syncHitboxes(enemy.hitboxes, enemy.stats, enemy.position);
      }
      // Hit flash decays on simulation time so it stays in step with the hit that
      // caused it, and it lives on the entry because the render layer may only
      // read simulation state — it never pushes state in.
      for (const enemy of entries) {
        if (enemy.view.hitFlash > 0) {
          enemy.view.hitFlash = Math.max(0, enemy.view.hitFlash - dt / 0.18);
        }
      }
      tick += 1;
    },

    byId(id) {
      return lookup.get(id);
    },

    spawn(archetype, position, options) {
      const stats = bodyStats(statsFor(archetype));
      const free = pool.get(archetype);
      const pooled = free && free.length > 0 ? free.pop() : undefined;
      // A recycled entry keeps its id. Pooling preserving identity is what lets a
      // late event from a previous life be recognised instead of being mistaken
      // for an event about the new one.
      const enemy = pooled ?? makeEnemy(nextId++, archetype, stats);
      // `Object.assign` rather than a replacement: `stats` is `readonly` on the state
      // and the render layer may hold a reference. One property changes; the rest of
      // the block is the archetype's.
      Object.assign(enemy.stats, stats);
      // A flying archetype is *placed* at its altitude instead of taking off from the ground.
      // The director's spawn points are ground positions by construction (they come from the
      // phase-3 arena sampler), so a gunship released at y = 0 would spend its first three
      // seconds climbing out of the floor — which reads as a spawn bug, not as a take-off.
      set(enemy.position, position.x, isFlying(archetype) ? HELICOPTER.altitude : position.y, position.z);
      copy(enemy.previousPosition, enemy.position);
      enemy.hitboxes = buildHitboxes(enemy.stats, enemy.position, enemy.hitboxes);
      resetEnemy(enemy, enemy.stats.maxHealth);
      enemy.fsm = options?.state ?? 'SPAWN';

      entries.push(enemy);
      lookup.set(enemy.id, enemy);
      indexById.set(enemy.id, entries.length - 1);
      return enemy;
    },

    despawn(enemy) {
      releaseSlot(enemy);
      if (!lookup.has(enemy.id)) return;
      enemy.alive = false;
      enemy.health = 0;
      retire(enemy);
    },

    applyDamage(enemy, amount, zone, point, direction) {
      if (!enemy.alive || amount <= 0) return null;
      enemy.health = Math.max(0, enemy.health - amount);
      enemy.totalDamageTaken += amount;
      enemy.lastHitTime = tick;
      enemy.view.hitFlash = 1;

      // Knockback is rate-limited. Without the limit, sustained automatic fire
      // holds a body in a permanent slide and it never closes on the player.
      const now = tick / SIM.tickHz;
      const rateLimited = now - enemy.lastKnockbackTime < ENEMY.knockbackCooldown;
      const knockback = rateLimited ? { speed: 0, stun: 0 } : resolveKnockback(amount, enemy.stats.mass, enemy.stats.maxHealth);
      if (knockback.speed > 0) {
        enemy.lastKnockbackTime = now;
        if (direction) {
          // Horizontal only: the vertical axis belongs to the ground solve, and a
          // launched body is a physics engine's job, not this one's.
          const length = Math.hypot(direction.x, direction.z);
          if (length > 1e-6) {
            enemy.velocity.x += (direction.x / length) * knockback.speed;
            enemy.velocity.z += (direction.z / length) * knockback.speed;
          }
        }
      }

      if (knockback.stun > 0 && stateCanBeInterrupted(enemy.fsm)) {
        enemy.stunRemaining = Math.max(enemy.stunRemaining, knockback.stun);
        releaseSlot(enemy);
        enemy.fsm = 'STAGGER';
        enemy.stateTime = 0;
      }

      // A heavy's weak point is its stagger lever (technical plan section 3.2.4): a single
      // body shot can never interrupt it, so cumulative weak-point damage is what buys the
      // player a window. Both heavies — the Warden and the gunship — use the same lever,
      // because a second boss with a second rule would be a second thing to learn.
      if (isHeavy(enemy.kind)) {
        if (zone === 'head') enemy.weakPointDamageSinceStagger += amount;
        const threshold = enemy.stats.maxHealth * 0.06;
        if (enemy.weakPointDamageSinceStagger >= threshold && enemy.fsm === 'REPOSITION') {
          enemy.weakPointDamageSinceStagger = 0;
          enemy.stunRemaining = Math.max(enemy.stunRemaining, ENEMY.stunDuration);
          enemy.fsm = 'STAGGER';
          enemy.stateTime = 0;
        }
      }

      events.emit('enemy:damaged', {
        tick,
        id: enemy.id,
        archetype: enemy.kind === 'dummy' ? 'small' : enemy.kind,
        amount,
        zone,
        remaining: enemy.health,
        max: enemy.stats.maxHealth,
        point,
        knockback: knockback.speed,
        direction: direction ?? ZERO,
      });

      if (isHeavy(enemy.kind) && !enemy.enraged && enemy.health > 0 && enemy.health <= enemy.stats.maxHealth * ENRAGE_HEALTH_FRACTION) {
        // Enrage is a numeric modifier, never a second state machine: this flips a
        // flag the frame reader consults and gives the change one readable beat.
        enemy.enraged = true;
        enemy.view.lunging = false;
        if (enemy.fsm === 'REPOSITION' || enemy.fsm === 'IDLE' || enemy.fsm === 'SPAWN') {
          enemy.fsm = 'ENRAGE';
          enemy.stateTime = 0;
          enemy.attackCooldown = 0;
        }
      }

      if (enemy.health > 0) return null;

      releaseSlot(enemy);
      enemy.alive = false;
      events.emit('enemy:died', {
        tick,
        id: enemy.id,
        archetype: enemy.kind === 'dummy' ? 'small' : enemy.kind,
        position: { x: enemy.position.x, y: enemy.position.y, z: enemy.position.z },
        scoreValue: enemy.stats.scoreValue,
      });
      return enemy;
    },

    applyBlast({ ownerId, position, radius, damage }) {
      let hits = 0;
      for (const enemy of entries) {
        if (!enemy.alive || enemy.id === ownerId) continue;
        const dx = enemy.position.x - position.x;
        const dz = enemy.position.z - position.z;
        const distance = Math.hypot(dx, dz);
        if (distance > radius) continue;
        // Linear falloff to zero at the blast's edge, floored at 1 so a hit that
        // visibly connected always registers.
        const falloff = 1 - distance / Math.max(radius, 1e-6);
        const amount = Math.max(1, Math.round(damage * falloff));
        store.applyDamage(enemy, amount, 'body', enemy.position, { x: dx, y: 0, z: dz });
        hits += 1;
      }
      return hits;
    },

    aliveCount() {
      let count = 0;
      for (const enemy of entries) if (enemy.alive) count += 1;
      return count;
    },

    liveCount(kind) {
      let count = 0;
      for (const enemy of entries) {
        if (!enemy.alive || enemy.kind === 'dummy') continue;
        if (kind === undefined || enemy.kind === kind) count += 1;
      }
      return count;
    },

    damagedCount() {
      let count = 0;
      for (const enemy of entries) if (enemy.totalDamageTaken > 0) count += 1;
      return count;
    },

    reset() {
      slots.reset();
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const enemy = entries[i];
        if (enemy && enemy.kind !== 'dummy') retire(enemy);
      }
      for (const dummy of dummies) {
        const { spec, enemy, maxHealth } = dummy;
        resetEnemy(enemy, maxHealth);
        set(enemy.position, spec.base.x, spec.base.y, spec.base.z);
        copy(enemy.previousPosition, enemy.position);
        syncHitboxes(enemy.hitboxes, enemy.stats, enemy.position);
        lookup.set(enemy.id, enemy);
      }
      reindex(0);
    },
  };

  return store;
}

/** Shared zero vector for event payloads that carry no direction. */
const ZERO: Vector3 = { x: 0, y: 0, z: 0 };
