/**
 * Player hitscan resolution and the damage it produces.
 *
 * This is the authoritative hit query for the whole game (technical plan
 * §3.2.5). It is analytic — rays against boxes and spheres — rather than a
 * `three` `Raycaster`, so the exact same code runs in a unit test and in the
 * browser, and so "which body part did that bullet hit" is decidable without a
 * GPU.
 *
 * Two invariants the rest of the game depends on:
 *
 *   1. **Sorted by distance, walls included.** Level blockers and target bodies
 *      live in the same query. A 5 m crate always beats a 9 m target, which is
 *      the only reason "I shot through the wall" cannot happen.
 *   2. **One shot, one damage instance per body.** Each shot carries a unique
 *      `shotId`; the piercing/pellet logic consults `alreadyHit` so a single
 *      trigger pull cannot double-dip on the same target.
 */

import type { EventSink, HitZone, SurfaceKind } from '../../core/events';
import { ENEMY_LARGE, ENEMY_SMALL, HITSTOP, WEAPON } from '../../core/config';
import {
  type Aabb,
  type Vector3,
  DEG2RAD,
  clone,
  cross,
  normalize,
  perpendicular,
  set as setVec,
  subtract,
} from '../../core/math/vec3';
import { createRayHit, rayAabb, raySphere, type RayHit } from '../../core/math/intersect';
import type { Rng } from '../../core/math/rng';
import { hitstopForDamage, resolveDamage } from './damage';
import type { EnemyStore } from '../enemies/EnemyStore';
import type { EnemyState } from '../enemies/EnemyState';

/** The static geometry a bullet can be stopped by. */
export interface BlockerWorld {
  readonly blockers: readonly Aabb[];
}

/** What the ray found, before damage is applied. */
export interface RawHit {
  readonly kind: 'target' | 'level';
  /** Metres from the ray origin. */
  distance: number;
  point: Vector3;
  normal: Vector3;
  /** Present when `kind === 'target'`. */
  target?: EnemyState;
  zone?: HitZone;
  surface: SurfaceKind;
}

/** A fully resolved shot, after damage and hitstop. */
export interface ShotResult {
  readonly shotId: number;
  /** Null when the shot hit nothing within `WEAPON.range`. */
  readonly hit: RawHit | null;
  /** Far end of the trace, for drawing a full-length tracer. */
  readonly end: Vector3;
  readonly spreadDeg: number;
  readonly damageDealt: number;
  readonly killed: boolean;
}

/** Public surface used by the player weapon system. */
export interface CombatSystem {
  /**
   * Resolves one shot.
   *
   * @param origin   Muzzle position. Never the camera: pushing the origin to the
   *                 weapon is what prevents "shot a wall the camera was inside".
   * @param aimedAt  The point the crosshair is on. The final direction is
   *                 `origin → aimedAt`, so the spread cone is centred on the
   *                 crosshair rather than on the barrel axis.
   * @param spreadDeg Half-angle of the spread cone.
   */
  fire(origin: Vector3, aimedAt: Vector3, spreadDeg: number): ShotResult;
  /** Monotonic shot counter; also the tracer identity. */
  readonly shotCount: number;
  /** Last registered impact, for the debug overlay. Null before the first shot. */
  readonly lastResult: ShotResult | null;
}

/** Which surface family a level prop reports for impact effects. */
function surfaceForBox(): SurfaceKind {
  // Blockers carry no material tag yet; concrete covers the shipped whitebox.
  // Phase 4 adds per-prop surface kinds when the level gains real materials.
  return 'concrete';
}

interface CombatDeps {
  readonly world: BlockerWorld;
  readonly targets: EnemyStore;
  readonly events: EventSink;
  readonly rng: Rng;
}

/**
 * Creates the combat system.
 *
 * Owns the small amount of mutable bookkeeping the query needs (shot counter,
 * scratch vectors) so the hot path allocates nothing per shot.
 */
export function createCombatSystem({ world, targets, events, rng }: CombatDeps): CombatSystem {
  const scratchHit = createRayHit();
  const direction = { x: 0, y: 0, z: 0 };
  const axis = { x: 0, y: 0, z: 0 };
  const spreadAxis = { x: 0, y: 0, z: 0 };
  const perpendicularScratch = { x: 0, y: 0, z: 0 };
  /** Per-shot record of which target ids have already taken damage. */
  const alreadyHit = new Set<number>();

  let shotCount = 0;
  let lastResult: ShotResult | null = null;
  let tick = 0;

  /** Advances the internal tick stamp. Called once per simulation step. */
  const beginTick = (): void => {
    tick += 1;
  };

  /** Nearest level blocker along the ray, or null. */
  const traceLevel = (origin: Vector3, dir: Vector3, maxDistance: number): RawHit | null => {
    let best: RawHit | null = null;
    for (const box of world.blockers) {
      const hit = rayAabb(scratchHit, origin, dir, box);
      if (!hit) continue;
      if (hit.t <= 0 || hit.t > maxDistance) continue;
      if (best && hit.t >= best.distance) continue;
      best = {
        kind: 'level',
        distance: hit.t,
        point: {
          x: origin.x + dir.x * hit.t,
          y: origin.y + dir.y * hit.t,
          z: origin.z + dir.z * hit.t,
        },
        normal: clone(hit.normal),
        surface: surfaceForBox(),
      };
    }
    return best;
  };

  /** Nearest target body part along the ray, or null. */
  const traceTargets = (origin: Vector3, dir: Vector3, maxDistance: number): RawHit | null => {
    let best: RawHit | null = null;
    for (const target of targets.targets) {
      if (!target.alive) continue;
      for (const hitbox of target.hitboxes) {
        const hit: RayHit | null =
          hitbox.shape === 'sphere'
            ? raySphere(scratchHit, origin, dir, hitbox.center, hitbox.radius)
            : rayAabb(scratchHit, origin, dir, hitbox.box);
        if (!hit) continue;
        if (hit.t <= 0 || hit.t > maxDistance) continue;
        if (best && hit.t >= best.distance) continue;
        best = {
          kind: 'target',
          distance: hit.t,
          point: {
            x: origin.x + dir.x * hit.t,
            y: origin.y + dir.y * hit.t,
            z: origin.z + dir.z * hit.t,
          },
          normal: clone(hit.normal),
          target,
          zone: hitbox.zone,
          surface: 'target',
        };
      }
    }
    return best;
  };

  /**
   * Applies the spread cone to the shot direction.
   *
   * The offset direction is drawn from the injected RNG, so a spread pattern is
   * reproducible from the world seed — which is the precondition for asserting
   * anything about accuracy in a test. The cone is built from a stable
   * perpendicular pair (never a degenerate cross product when looking straight
   * up) and the deflection is exact: a uniform angle on a uniform azimuth, no
   * `tan()` shortcut that distorts the cone at large angles.
   */
  const applySpread = (out: Vector3, dir: Vector3, spreadDeg: number): void => {
    if (spreadDeg <= 0) {
      setVec(out, dir.x, dir.y, dir.z);
      return;
    }
    // Two draws, no more: one for where in the cone, one for how far out.
    // `sqrt` of a uniform sample gives a uniform distribution *over the disc*,
    // which is what a spread pattern is; using the raw sample would cluster
    // every bullet near the centre and make the cone read as tighter than it is.
    const angle = rng.next() * Math.PI * 2;
    const deflection = Math.sqrt(rng.next()) * spreadDeg * DEG2RAD;

    // Orthonormal basis around the aim direction. `perpendicular` picks the world
    // axis least aligned with `dir`, so this never degenerates when the player
    // looks straight up.
    perpendicular(perpendicularScratch, dir);
    normalize(perpendicularScratch, perpendicularScratch);
    cross(axis, dir, perpendicularScratch);
    normalize(axis, axis);
    cross(spreadAxis, axis, dir);
    normalize(spreadAxis, spreadAxis);

    const cos = Math.cos(deflection);
    const sin = Math.sin(deflection);
    const radialCos = Math.cos(angle);
    const radialSin = Math.sin(angle);
    out.x = dir.x * cos + (axis.x * radialCos + spreadAxis.x * radialSin) * sin;
    out.y = dir.y * cos + (axis.y * radialCos + spreadAxis.y * radialSin) * sin;
    out.z = dir.z * cos + (axis.z * radialCos + spreadAxis.z * radialSin) * sin;
    normalize(out, out);
  };

  const resolveOnePellet = (
    shotId: number,
    origin: Vector3,
    dir: Vector3,
    spreadDeg: number,
  ): { hit: RawHit | null; damage: number; killed: boolean; end: Vector3 } => {
    const levelHit = traceLevel(origin, dir, WEAPON.range);
    const targetHit = traceTargets(origin, dir, levelHit ? levelHit.distance : WEAPON.range);
    // A level hit at a shorter distance than any target wins outright: that is
    // the "5 m wall beats 9 m enemy" rule from the technical plan.
    const hit = targetHit ?? levelHit;
    const end = hit
      ? clone(hit.point)
      : {
          x: origin.x + dir.x * WEAPON.range,
          y: origin.y + dir.y * WEAPON.range,
          z: origin.z + dir.z * WEAPON.range,
        };

    if (!hit) {
      events.emit('bullet:miss', { tick, shotId, end: clone(end) });
      return { hit: null, damage: 0, killed: false, end };
    }

    events.emit('bullet:impact', {
      tick,
      shotId,
      point: clone(hit.point),
      normal: clone(hit.normal),
      surface: hit.surface,
      distance: hit.distance,
    });

    if (hit.kind !== 'target' || !hit.target || !hit.zone) {
      return { hit, damage: 0, killed: false, end };
    }

    const target = hit.target;
    // One trigger pull, one damage instance per body.
    if (!WEAPON.canMultiHitPerShot && alreadyHit.has(target.id)) {
      return { hit, damage: 0, killed: false, end };
    }
    alreadyHit.add(target.id);

    const breakdown = resolveDamage({
      baseDamage: WEAPON.damage,
      zone: hit.zone,
      weakPointMultiplier: target.weakPointMultiplier,
      distance: hit.distance,
      spreadDeg,
    });
    const hitstop = hitstopForDamage(breakdown.final, hit.zone, HITSTOP);

    events.emit('hit:registered', {
      tick,
      shotId,
      targetId: target.id,
      zone: hit.zone,
      baseDamage: WEAPON.damage,
      finalDamage: breakdown.final,
      distance: hit.distance,
      point: clone(hit.point),
      hitstop,
    });

    return { hit, damage: breakdown.final, killed: false, end };
  };

  const system: CombatSystem = {
    get shotCount() {
      return shotCount;
    },
    get lastResult() {
      return lastResult;
    },

    fire(origin, aimedAt, spreadDeg) {
      beginTick();
      shotCount += 1;
      const shotId = shotCount;
      subtract(direction, aimedAt, origin);
      normalize(direction, direction);
      alreadyHit.clear();

      let totalDamage = 0;
      let anyKill = false;
      let firstHit: RawHit | null = null;
      let end = clone(origin);

      const pellets = Math.max(1, WEAPON.pelletsPerShot);
      for (let pellet = 0; pellet < pellets; pellet += 1) {
        applySpread(direction, direction, spreadDeg);
        const resolved = resolveOnePellet(shotId, origin, direction, spreadDeg);
        if (!firstHit && resolved.hit) firstHit = resolved.hit;
        end = resolved.end;
        totalDamage += resolved.damage;
      }

      // Damage is applied centrally so hitstop, death and the damage number all
      // come from one place. The weak point multiplier comes from the victim, so
      // the 2.8 / 1.6 split between the two archetypes is read from the body that
      // was hit rather than chosen by the shooter.
      if (firstHit?.kind === 'target' && firstHit.target && firstHit.zone && totalDamage > 0) {
        const victim = firstHit.target;
        // The impulse direction is the shot's, resolved horizontally inside the
        // store: knockback pushes a body away from the shooter, and the vertical
        // axis belongs to the ground solve.
        const killed = targets.applyDamage(victim, totalDamage, firstHit.zone, firstHit.point, direction);
        anyKill = killed !== null;
      }

      lastResult = {
        shotId,
        hit: firstHit,
        end,
        spreadDeg,
        damageDealt: totalDamage,
        killed: anyKill,
      };
      return lastResult;
    },
  };

  return system;
}

/**
 * Multiplier a body part applies for a given target kind.
 *
 * Phase 2 replaces this with a per-archetype lookup; exporting it now keeps the
 * weak point rule visible in one place instead of inlined in the ray loop.
 * Values are read from the archetype stats rather than repeated here — a
 * duplicated literal is how a rebalance silently fails to take effect on one
 * of the two code paths.
 */
export function weakPointMultiplierFor(kind: 'small' | 'large'): number {
  return kind === 'small' ? ENEMY_SMALL.headshotMultiplier : ENEMY_LARGE.headshotMultiplier;
}

/** Reusable helper for tests and the debug panel: full-length trace end point. */
export function traceEnd(origin: Vector3, dir: Vector3): Vector3 {
  return {
    x: origin.x + dir.x * WEAPON.range,
    y: origin.y + dir.y * WEAPON.range,
    z: origin.z + dir.z * WEAPON.range,
  };
}
