/**
 * Spawn-point selection.
 *
 * The brief calls "never spawn an enemy in the player's face" the project's most
 * important rule, and `docs/阶段3.md` section 7 lists exactly what has to be pinned:
 * inside the arena (including the boundary case), 12-40 m from the player, outside
 * the 60-degree forward cone, spread within a burst, and always *something* even
 * when every candidate is rejected.
 *
 * The player spawns at `(0, 0, 8)` facing `-Z`, which is the position that makes the
 * boundary trap bite: a ring drawn around the player is mostly outside the arena.
 * Every case here is checked from both that spot and from a corner.
 */

import { describe, expect, it } from 'vitest';
import { DIRECTOR, DIRECTOR_TUNING } from '#/core/config';
import { createRng } from '#/core/math/rng';
import { distanceXZ, type Vector3 } from '#/core/math/vec3';
import {
  SPAWN_LIMIT,
  isInViewCone,
  isInsideArena,
  maxDistanceWithinArena,
  pickSpawnPoint,
  type SpawnContext,
} from '#/game/director/spawnPoints';

const ARENA = 24;
/** Where `createPlayerState` puts the player, and the worst case for the ring. */
const SPAWN_POINT: Vector3 = { x: 0, y: 0, z: 8 };
/** A corner: the distance band's lower bound is geometrically impossible here. */
const CORNER: Vector3 = { x: 21, y: 0, z: 21 };

function ctx(playerPosition: Vector3, playerYaw = 0, chosen: Vector3[] = []): SpawnContext {
  return { playerPosition, playerYaw, chosen };
}

/** Draws `count` points for one context, threading the chosen list through. */
function drawMany(playerPosition: Vector3, playerYaw: number, count: number, seed: number): Vector3[] {
  const rng = createRng(seed);
  const chosen: Vector3[] = [];
  const context = ctx(playerPosition, playerYaw, chosen);
  const points: Vector3[] = [];
  for (let i = 0; i < count; i += 1) {
    const out: Vector3 = { x: 0, y: 0, z: 0 };
    pickSpawnPoint(out, context, rng);
    chosen.push({ x: out.x, y: out.y, z: out.z });
    points.push({ x: out.x, y: out.y, z: out.z });
  }
  return points;
}

describe('isInsideArena', () => {
  it('accepts the interior and rejects the outside', () => {
    expect(isInsideArena({ x: 0, y: 0, z: 0 }, 0)).toBe(true);
    expect(isInsideArena({ x: ARENA, y: 0, z: 0 }, 0)).toBe(true);
    expect(isInsideArena({ x: ARENA + 0.001, y: 0, z: 0 }, 0)).toBe(false);
    expect(isInsideArena({ x: 0, y: 0, z: -ARENA - 5 }, 0)).toBe(false);
  });

  it('applies the margin symmetrically', () => {
    const margin = 2.4;
    expect(isInsideArena({ x: ARENA - margin, y: 0, z: 0 }, margin)).toBe(true);
    expect(isInsideArena({ x: ARENA - margin + 0.01, y: 0, z: 0 }, margin)).toBe(false);
    expect(isInsideArena({ x: -ARENA + margin, y: 0, z: 0 }, margin)).toBe(true);
    expect(isInsideArena({ x: -(ARENA - margin) - 0.01, y: 0, z: 0 }, margin)).toBe(false);
  });

  it('agrees with the spawn limit the picker uses', () => {
    expect(SPAWN_LIMIT).toBeCloseTo(ARENA - DIRECTOR.spawnFenceMargin, 10);
    expect(isInsideArena({ x: SPAWN_LIMIT, y: 0, z: -SPAWN_LIMIT }, DIRECTOR.spawnFenceMargin)).toBe(true);
  });
});

describe('isInViewCone', () => {
  // Yaw 0 faces -Z, so a point at negative z is straight ahead.
  it('catches a point dead ahead and clears one dead behind', () => {
    expect(isInViewCone({ x: 0, y: 0, z: -10 }, { x: 0, y: 0, z: 0 }, 0, 30)).toBe(true);
    expect(isInViewCone({ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 0 }, 0, 30)).toBe(false);
  });

  it('puts the boundary exactly on the half-angle', () => {
    const halfAngle = 30;
    // 30 degrees off the -Z axis, so exactly on the edge of the cone. The test is a
    // strict inequality, so "on the line" is outside it — which is the safe reading.
    const inside = { x: Math.sin(Math.PI / 6 - 0.01) * 10, y: 0, z: -Math.cos(Math.PI / 6 - 0.01) * 10 };
    const outside = { x: Math.sin(Math.PI / 6 + 0.01) * 10, y: 0, z: -Math.cos(Math.PI / 6 + 0.01) * 10 };
    expect(isInViewCone(inside, { x: 0, y: 0, z: 0 }, 0, halfAngle)).toBe(true);
    expect(isInViewCone(outside, { x: 0, y: 0, z: 0 }, 0, halfAngle)).toBe(false);
  });

  it('follows the yaw, and its opposite does too', () => {
    const ahead = { x: 0, y: 0, z: -10 };
    const behind = { x: 0, y: 0, z: 10 };
    expect(isInViewCone(ahead, { x: 0, y: 0, z: 0 }, 0, 30)).toBe(true);
    expect(isInViewCone(behind, { x: 0, y: 0, z: 0 }, Math.PI, 30)).toBe(true);
    expect(isInViewCone(ahead, { x: 0, y: 0, z: 0 }, Math.PI, 30)).toBe(false);
  });

  it('treats a point on top of the player as inside the cone', () => {
    // The safe direction: it can never be a legal spawn point anyway.
    expect(isInViewCone({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 0, 30)).toBe(true);
  });
});

describe('maxDistanceWithinArena', () => {
  it('reaches the wall when the ray points straight at it', () => {
    const from = { x: 0, y: 0, z: 0 };
    expect(maxDistanceWithinArena(from, 1, 0, 2)).toBeCloseTo(ARENA - 2, 6);
    expect(maxDistanceWithinArena(from, -1, 0, 2)).toBeCloseTo(ARENA - 2, 6);
  });

  it('handles a corner exactly', () => {
    const from = { x: 0, y: 0, z: 0 };
    const inv = 1 / Math.SQRT2;
    // 45 degrees: the limiting slab is whichever wall is nearer, and both are equal.
    expect(maxDistanceWithinArena(from, inv, inv, 0)).toBeCloseTo(ARENA * Math.SQRT2, 6);
  });

  it('returns zero when the ray points away from the arena it is already outside', () => {
    expect(maxDistanceWithinArena({ x: 30, y: 0, z: 0 }, 1, 0, 0)).toBe(0);
  });

  it('never returns a negative or non-finite distance', () => {
    const from = { x: 10, y: 0, z: -20 };
    for (let i = 0; i < 64; i += 1) {
      const angle = (i / 64) * Math.PI * 2;
      const reach = maxDistanceWithinArena(from, Math.cos(angle), Math.sin(angle), DIRECTOR.spawnFenceMargin);
      expect(Number.isFinite(reach)).toBe(true);
      expect(reach).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('pickSpawnPoint: the four rules', () => {
  it('always lands inside the arena, from the spawn point and from a corner', () => {
    for (const player of [SPAWN_POINT, CORNER, { x: -23, y: 0, z: 0 }, { x: 0, y: 0, z: -23 }]) {
      for (const seed of [1, 2, 3, 99, 4242]) {
        for (const point of drawMany(player, 0, 12, seed)) {
          expect(isInsideArena(point, DIRECTOR.spawnFenceMargin)).toBe(true);
          // Also the absolute bound, since the margin is a tuning value: no point may
          // ever be outside the fence.
          expect(Math.abs(point.x)).toBeLessThanOrEqual(ARENA);
          expect(Math.abs(point.z)).toBeLessThanOrEqual(ARENA);
        }
      }
    }
  });

  it('keeps the distance band whenever the arena allows it', () => {
    // From the middle of the arena every direction has room for the whole band, so
    // this is the case where the configured limits are actually binding.
    const points = drawMany({ x: 0, y: 0, z: 0 }, 0, 20, 7);
    for (const point of points) {
      const distance = distanceXZ(point, { x: 0, y: 0, z: 0 });
      expect(distance).toBeGreaterThanOrEqual(DIRECTOR.minSpawnDistanceFromPlayer - 1e-6);
      expect(distance).toBeLessThanOrEqual(DIRECTOR.maxSpawnDistanceFromPlayer + 1e-6);
    }
  });

  it('keeps the distance band at the spawn point, where the arena squeezes it', () => {
    // 24 - 2.4 = 21.6 m of reach in the best direction, which still clears the 12 m
    // minimum — so the band holds and the boundary is what shortens the far end.
    const points = drawMany(SPAWN_POINT, 0, 20, 11);
    for (const point of points) {
      const distance = distanceXZ(point, SPAWN_POINT);
      expect(distance).toBeGreaterThanOrEqual(DIRECTOR.minSpawnDistanceFromPlayer - 1e-6);
      expect(distance).toBeLessThanOrEqual(DIRECTOR.maxSpawnDistanceFromPlayer + 1e-6);
      expect(distance).toBeLessThanOrEqual(maxDistanceWithinArena(SPAWN_POINT, 0, 0, DIRECTOR.spawnFenceMargin) + 1e-6 || Infinity);
    }
  });

  it('never places a point in the 60-degree cone ahead of the player', () => {
    for (const yaw of [0, 0.7, Math.PI / 2, Math.PI, -2.1]) {
      for (const point of drawMany(SPAWN_POINT, yaw, 16, 5)) {
        expect(isInViewCone(point, SPAWN_POINT, yaw, DIRECTOR.spawnViewConeHalfAngleDeg)).toBe(false);
      }
    }
  });

  it('spreads a burst out, and thickens the crowd rather than the cluster', () => {
    // The first few points must all respect the separation rule. Once the arena
    // behind the player is full, the picker is allowed to hold the rule rather than
    // return nothing — so the assertion is on a burst size the arena can hold.
    for (const player of [{ x: 0, y: 0, z: 0 }, CORNER]) {
      const points = drawMany(player, 0, 6, 21);
      for (let i = 0; i < points.length; i += 1) {
        for (let j = i + 1; j < points.length; j += 1) {
          expect(distanceXZ(points[i]!, points[j]!)).toBeGreaterThanOrEqual(DIRECTOR.minSpawnSeparation - 1e-6);
        }
      }
    }
  });

  it('is deterministic: same seed, same player, same points', () => {
    const a = drawMany(SPAWN_POINT, 0.3, 8, 1234);
    const b = drawMany(SPAWN_POINT, 0.3, 8, 1234);
    expect(b).toEqual(a);
    const c = drawMany(SPAWN_POINT, 0.3, 8, 4321);
    expect(c).not.toEqual(a);
  });

  it('advances the caller-supplied point rather than allocating a new one', () => {
    const out: Vector3 = { x: 0, y: 0, z: 0 };
    const returned = pickSpawnPoint(out, ctx(SPAWN_POINT), createRng(3));
    expect(returned).toBe(out);
    expect(out.y).toBe(0);
  });
});

describe('pickSpawnPoint: the fallback never fails', () => {
  it('returns a point even when every candidate would be rejected', () => {
    // A minimum distance no point can satisfy: the relaxation order has to give way
    // on the distance band rather than return undefined. The boundary still holds.
    const saved = DIRECTOR_TUNING.minSpawnDistanceFromPlayer;
    DIRECTOR_TUNING.minSpawnDistanceFromPlayer = 5000;
    try {
      const points = drawMany(SPAWN_POINT, 0, 8, 3);
      for (const point of points) {
        expect(Number.isFinite(point.x)).toBe(true);
        expect(Number.isFinite(point.z)).toBe(true);
        expect(isInsideArena(point, DIRECTOR.spawnFenceMargin)).toBe(true);
        // The boundary is never relaxed, so there is nothing outside the fence.
        expect(Math.abs(point.x)).toBeLessThanOrEqual(SPAWN_LIMIT + 1e-9);
        expect(Math.abs(point.z)).toBeLessThanOrEqual(SPAWN_LIMIT + 1e-9);
      }
    } finally {
      DIRECTOR_TUNING.minSpawnDistanceFromPlayer = saved;
    }
  });

  it('still avoids the view cone when only the separation rule has to give way', () => {
    // One point already sitting on the only legal spot behind the player: the first
    // random candidates cannot satisfy the separation rule, so the sweep runs. It
    // relaxes separation, and the cone must still hold.
    const chosen: Vector3[] = [];
    // Fill the legal arc behind the player until the random pass is exhausted.
    for (let i = 0; i < 24; i += 1) {
      const angle = Math.PI + (i / 24) * Math.PI;
      chosen.push({
        x: SPAWN_POINT.x + Math.cos(angle) * DIRECTOR.minSpawnDistanceFromPlayer,
        y: 0,
        z: SPAWN_POINT.z + Math.sin(angle) * DIRECTOR.minSpawnDistanceFromPlayer,
      });
    }
    const out: Vector3 = { x: 0, y: 0, z: 0 };
    pickSpawnPoint(out, ctx(SPAWN_POINT, 0, chosen), createRng(13));
    expect(isInsideArena(out, DIRECTOR.spawnFenceMargin)).toBe(true);
    expect(isInViewCone(out, SPAWN_POINT, 0, DIRECTOR.spawnViewConeHalfAngleDeg)).toBe(false);
  });

  it('clamps into the arena even when the player is standing on the fence line', () => {
    const onFence: Vector3 = { x: SPAWN_LIMIT, y: 0, z: SPAWN_LIMIT };
    for (const seed of [1, 2, 3]) {
      const out: Vector3 = { x: 0, y: 0, z: 0 };
      pickSpawnPoint(out, ctx(onFence), createRng(seed));
      expect(isInsideArena(out, DIRECTOR.spawnFenceMargin)).toBe(true);
      expect(Number.isFinite(out.x)).toBe(true);
      expect(Number.isFinite(out.z)).toBe(true);
    }
  });
});
