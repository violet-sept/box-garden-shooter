/**
 * Where an enemy is allowed to appear.
 *
 * Pure functions: a player position and facing go in, a legal point comes out. No
 * world, no store, no state. That is deliberate — this is the rule the brief calls
 * out as the project's most important one ("never spawn in the player's face"), and
 * a rule that can only be checked by watching a run is a rule that will regress.
 *
 * ## Order of the filters is load-bearing
 *
 *   1. **inside the arena** (minus the fence keep-out)
 *   2. distance from the player, 12-40 m
 *   3. outside the 60-degree cone in front of the player
 *   4. at least `minSpawnSeparation` from the other points in this burst
 *
 * The candidate ring is drawn around the *player*, and the player spawns at
 * `(0, 0, 8)` in a `+-24 m` arena — so an 18 m ring reaches `z = 26`, which is
 * outside the fence. Filtering by distance first and clamping to the arena
 * afterwards squashes the surviving points onto the fence line and makes the
 * distance rule meaningless; not clamping puts enemies outside the arena. The
 * boundary test therefore comes **first**, and it is the one filter that is never
 * relaxed (technical plan section 4.7, `docs/阶段3.md` section 3.6).
 *
 * ## How the boundary is satisfied without rejection sampling
 *
 * A random direction is chosen first, then the distance the arena actually allows
 * along it, and the sample is drawn from the intersection of that and the
 * configured band. Every candidate is therefore legal by construction, and the
 * sampler does not degenerate when the player stands in a corner — where a naive
 * ring would have almost no valid arc and would burn dozens of rejected draws.
 *
 * ## The fallback never fails, and relaxes in one direction only
 *
 * If no random candidate passes, directions are swept with the separation rule
 * relaxed, then the view cone, then the *minimum* distance. That last one matters:
 * standing against a fence makes the configured 12 m minimum geometrically
 * impossible (the far wall is 10 m away), and the choice is then between "an enemy
 * slightly closer than ideal" and "no enemy at all". The arena boundary is still
 * never crossed.
 */

import { DIRECTOR } from '../../core/config';
import type { Rng } from '../../core/math/rng';
import { DEG2RAD, type Vector3, distanceXZ, set } from '../../core/math/vec3';

/** Arena half-extent. Mirrors `SIM.arenaHalfSize`, kept local to avoid an import cycle. */
const ARENA_HALF_SIZE = 24;

/**
 * Arena half-extent minus the fence keep-out.
 *
 * The legal footprint for a spawn point. Exported so tests assert against the edge
 * case rather than re-deriving the subtraction.
 */
export const SPAWN_LIMIT = ARENA_HALF_SIZE - DIRECTOR.spawnFenceMargin;

/** What the picker is allowed to know about the world when it chooses a point. */
export interface SpawnContext {
  readonly playerPosition: Vector3;
  /** Player facing in radians; 0 is -Z, matching the whole project's convention. */
  readonly playerYaw: number;
  /** Points already chosen for this burst, which the new one must keep away from. */
  readonly chosen: readonly Vector3[];
}

/**
 * True when `p` is inside the playable footprint with `margin` metres to spare.
 *
 * The ground plane is not tested: every point in the simulation is authored with
 * `y = 0` and the enemy integrator snaps `y` to the surface beneath the feet. A
 * spawn point is a ground position, not a volume.
 */
export function isInsideArena(p: Vector3, margin: number): boolean {
  const limit = ARENA_HALF_SIZE - margin;
  return Math.abs(p.x) <= limit && Math.abs(p.z) <= limit;
}

/**
 * True when `p` lies inside the horizontal cone of `halfAngleDeg` about the
 * direction the player is facing.
 *
 * A dot-product test rather than an `acos`: exact, and it cannot produce an angle
 * from a degenerate vector.
 */
export function isInViewCone(p: Vector3, from: Vector3, yaw: number, halfAngleDeg: number): boolean {
  const dx = p.x - from.x;
  const dz = p.z - from.z;
  const lengthSq = dx * dx + dz * dz;
  // A point on top of the player counts as in front of them: refusing it is the
  // safe direction, and it can never be a legal point anyway.
  if (lengthSq < 1e-9) return true;
  const inv = 1 / Math.sqrt(lengthSq);
  // Forward for this yaw convention is `(-sin(yaw), -cos(yaw))`.
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  return (dx * inv) * fx + (dz * inv) * fz > Math.cos(halfAngleDeg * DEG2RAD);
}

/**
 * How far a ray from `from` along the unit direction `(dirX, dirZ)` travels before
 * leaving the arena's legal footprint.
 *
 * Solved per axis against the slab, so it is exact for any direction — including
 * the ones that leave through a corner.
 */
export function maxDistanceWithinArena(from: Vector3, dirX: number, dirZ: number, margin: number): number {
  const limit = ARENA_HALF_SIZE - margin;
  // Guards the parallel case: a direction with no component on an axis never
  // leaves through that slab, so the bound comes from the other axis instead of a
  // division by zero.
  const epsilon = 1e-9;
  let best = Infinity;
  if (dirX > epsilon) best = Math.min(best, (limit - from.x) / dirX);
  else if (dirX < -epsilon) best = Math.min(best, (-limit - from.x) / dirX);
  if (dirZ > epsilon) best = Math.min(best, (limit - from.z) / dirZ);
  else if (dirZ < -epsilon) best = Math.min(best, (-limit - from.z) / dirZ);
  return Math.max(0, best);
}

/**
 * The distance band a direction can actually offer: the configured band clipped to
 * what the arena allows along that ray. `high < low` means "nothing on this ray is
 * legal", which is a normal outcome near a corner and not an error.
 */
function bandFor(player: Vector3, dirX: number, dirZ: number): { low: number; high: number } {
  const low = DIRECTOR.minSpawnDistanceFromPlayer;
  const high = Math.min(DIRECTOR.maxSpawnDistanceFromPlayer, maxDistanceWithinArena(player, dirX, dirZ, DIRECTOR.spawnFenceMargin));
  return { low, high };
}

/** Module-level scratch: the picker allocates nothing per call. */
const scratchPoint: Vector3 = { x: 0, y: 0, z: 0 };

/**
 * Picks one legal spawn point into `out`.
 *
 * Never returns `undefined` and never returns a point outside the arena. The caller
 * supplies `ctx.chosen` (the points already taken in this burst) and gets a point
 * that respects every rule that is geometrically satisfiable.
 */
export function pickSpawnPoint(out: Vector3, ctx: SpawnContext, rng: Rng): Vector3 {
  const config = DIRECTOR;

  // 1. Random candidates. Each is legal by construction: the direction is random,
  //    the distance is drawn from what the arena allows along it.
  for (let i = 0; i < config.spawnCandidateCount; i += 1) {
    const angle = rng.range(0, Math.PI * 2);
    const dirX = Math.cos(angle);
    const dirZ = Math.sin(angle);
    const band = bandFor(ctx.playerPosition, dirX, dirZ);
    // Nothing on this ray satisfies the distance rule — the next direction is a
    // better use of the draw than a point that will certainly be rejected.
    if (band.high < band.low) continue;
    const distance = rng.range(band.low, band.high);
    set(scratchPoint, ctx.playerPosition.x + dirX * distance, 0, ctx.playerPosition.z + dirZ * distance);
    if (!passes(scratchPoint, ctx, config.minSpawnSeparation, config.spawnViewConeHalfAngleDeg)) continue;
    return set(out, scratchPoint.x, 0, scratchPoint.z);
  }

  // 2. Direction sweep, relaxing in the order the brief allows: separation first
  //    (it only ever causes clustering), then the view cone (the player has been
  //    warned about this point), then the lower distance bound (the arena may make
  //    it impossible).
  const sweep = config.spawnFallbackDirections;
  const relaxations = [
    { cone: true, minDistance: config.minSpawnDistanceFromPlayer },
    { cone: false, minDistance: config.minSpawnDistanceFromPlayer },
    { cone: false, minDistance: 0 },
  ];

  // A per-burst start angle: without it the sweep would pick the same absolute
  // direction for every burst, and a fallback wave would read as a formation.
  const phase = rng.next() * (Math.PI * 2);
  for (const relaxation of relaxations) {
    for (let i = 0; i < sweep; i += 1) {
      const angle = phase + (i / sweep) * Math.PI * 2;
      const dirX = Math.cos(angle);
      const dirZ = Math.sin(angle);
      const low = relaxation.minDistance;
      const high = Math.min(config.maxSpawnDistanceFromPlayer, maxDistanceWithinArena(ctx.playerPosition, dirX, dirZ, config.spawnFenceMargin));
      if (high < low) continue;
      // Spread the fallback through the band rather than pinning it to the far
      // edge: a ring of identical radii looks authored, and it is also easier to
      // shoot. The 0.85 floor exists so that clearing the separation rule still
      // produces points far enough apart.
      const distance = low + (high - low) * (0.85 + 0.15 * ((i + 1) / sweep));
      set(scratchPoint, ctx.playerPosition.x + dirX * distance, 0, ctx.playerPosition.z + dirZ * distance);
      if (!isInsideArena(scratchPoint, config.spawnFenceMargin)) continue;
      if (relaxation.cone && isInViewCone(scratchPoint, ctx.playerPosition, ctx.playerYaw, config.spawnViewConeHalfAngleDeg)) {
        continue;
      }
      if (!separatedFromChosen(scratchPoint, ctx, config.minSpawnSeparation)) continue;
      return set(out, scratchPoint.x, 0, scratchPoint.z);
    }
  }

  // 3. Catch-all. Reached only when the arena holds no point that satisfies even the
  //    relaxed rules — a margin wider than the arena, or a player standing on the
  //    fence line. The boundary is the last thing to give way, and it does not give
  //    way here either: the result is clamped *into* the arena rather than trusting
  //    a direction that has already failed.
  const signX = ctx.playerPosition.x >= 0 ? 1 : -1;
  const signZ = ctx.playerPosition.z >= 0 ? 1 : -1;
  return set(out, SPAWN_LIMIT * signX, 0, SPAWN_LIMIT * signZ);
}

/** The four rules, in one place so the picker and the tests cannot disagree. */
function passes(point: Vector3, ctx: SpawnContext, separation: number, halfAngleDeg: number): boolean {
  // Rule 1 first, and the only rule that is also enforced by construction.
  if (!isInsideArena(point, DIRECTOR.spawnFenceMargin)) return false;
  const distance = distanceXZ(point, ctx.playerPosition);
  if (distance < DIRECTOR.minSpawnDistanceFromPlayer) return false;
  if (distance > DIRECTOR.maxSpawnDistanceFromPlayer) return false;
  if (isInViewCone(point, ctx.playerPosition, ctx.playerYaw, halfAngleDeg)) return false;
  return separatedFromChosen(point, ctx, separation);
}

/** True when `point` keeps `separation` metres from every point already chosen. */
function separatedFromChosen(point: Vector3, ctx: SpawnContext, separation: number): boolean {
  if (separation <= 0) return true;
  for (const other of ctx.chosen) {
    if (distanceXZ(point, other) < separation) return false;
  }
  return true;
}
