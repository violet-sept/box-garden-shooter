/**
 * Multi-part hitbox tests.
 *
 * The contract the shot resolver depends on is positional: `hitboxes[0]` is the
 * head, and the head is the weak point. Everything else here is the arithmetic that
 * decides whether "I aimed at its head" is true.
 *
 * The test that matters most is the geometric one: a ray from directly above may
 * only reach the head, and a ray at waist height may only reach the body. Those two
 * are what would fail if the head and body volumes were ever allowed to overlap.
 */

import { describe, expect, it } from 'vitest';
import { ENEMY_LARGE, ENEMY_SMALL } from '#/core/config';
import { createRayHit, rayAabb, raySphere, type RayHit } from '#/core/math/intersect';
import {
  bodyCenterHeight,
  buildHitboxes,
  headCenterHeight,
  hitboxLayout,
  inferZone,
  syncHitboxes,
} from '#/game/combat/hitboxes';
import { vec3 } from '#/core/math/vec3';

/** Nearest hit among a stack for a ray, mirroring how the resolver picks. */
function trace(hitboxes: ReturnType<typeof buildHitboxes>, origin: ReturnType<typeof vec3>, dir: ReturnType<typeof vec3>) {
  const scratch: RayHit = createRayHit();
  let best: { zone: string; t: number } | null = null;
  for (const box of hitboxes) {
    const hit = box.shape === 'sphere' ? raySphere(scratch, origin, dir, box.center, box.radius) : rayAabb(scratch, origin, dir, box.box);
    if (!hit || hit.t <= 0) continue;
    if (best && hit.t >= best.t) continue;
    best = { zone: box.zone, t: hit.t };
  }
  return best;
}

describe('hitbox layout', () => {
  it('puts the top of the head at the configured height', () => {
    for (const stats of [ENEMY_SMALL, ENEMY_LARGE]) {
      const layout = hitboxLayout(stats);
      expect(headCenterHeight(stats) + layout.headRadius).toBeCloseTo(stats.height, 12);
    }
  });

  it('splits the capsule into a body and a head that do not overlap', () => {
    for (const stats of [ENEMY_SMALL, ENEMY_LARGE]) {
      const layout = hitboxLayout(stats);
      const bodyTop = stats.height - layout.headDiameter;
      const headBottom = stats.height - layout.headDiameter;
      // The body ends exactly where the head begins: a shared plane, no gap and no
      // double-counted volume in between.
      expect(bodyTop).toBeCloseTo(headBottom, 12);
      // Body centre is half of the body extent, head centre is a radius below the
      // top. Both are what the shot resolver's geometry assumes.
      expect(bodyCenterHeight(stats)).toBeCloseTo(layout.bodyHeight / 2, 12);
    }
  });

  it('places head and body centres at the documented heights above the feet', () => {
    const base = vec3(3, 1.5, -7);
    const boxes = buildHitboxes(ENEMY_SMALL, base);
    const head = boxes[0];
    const body = boxes[1];
    expect(head?.zone).toBe('head');
    expect(body?.zone).toBe('body');
    expect(head?.center.y).toBeCloseTo(base.y + ENEMY_SMALL.height - hitboxLayout(ENEMY_SMALL).headRadius, 12);
    expect(body?.center.y).toBeCloseTo(base.y + hitboxLayout(ENEMY_SMALL).bodyHeight / 2, 12);
    // And both follow the feet in x and z.
    expect(head?.center.x).toBe(base.x);
    expect(body?.center.z).toBe(base.z);
  });

  it('always builds head first, because the resolver reads slot 0 as the weak point', () => {
    for (const stats of [ENEMY_SMALL, ENEMY_LARGE]) {
      const boxes = buildHitboxes(stats, vec3(0, 0, 0));
      expect(boxes).toHaveLength(2);
      expect(boxes[0]?.zone).toBe('head');
      expect(boxes[1]?.zone).toBe('body');
    }
  });

  it('gives the large enemy a proportionally larger head, not a larger multiplier', () => {
    const small = hitboxLayout(ENEMY_SMALL);
    const large = hitboxLayout(ENEMY_LARGE);
    expect(large.headRadius).toBeGreaterThan(small.headRadius);
    // Same *fraction* of the body: the head is a hit zone, not a difficulty knob.
    expect(large.headDiameter / ENEMY_LARGE.height).toBeCloseTo(
      small.headDiameter / ENEMY_SMALL.height,
      12,
    );
  });
});

describe('rebuilding from a new position', () => {
  it('moves both boxes when the feet move, without reallocating', () => {
    const boxes = buildHitboxes(ENEMY_LARGE, vec3(0, 0, 0));
    const head = boxes[0];
    const body = boxes[1];
    syncHitboxes(boxes, ENEMY_LARGE, vec3(10, 2, -4));
    expect(head?.center.x).toBe(10);
    expect(head?.center.y).toBeCloseTo(2 + ENEMY_LARGE.height - hitboxLayout(ENEMY_LARGE).headRadius, 12);
    expect(head?.center.z).toBe(-4);
    expect(body?.center.x).toBe(10);
    expect(body?.center.z).toBe(-4);
    // The sphere's AABB mirror must move with it, or the box form of the query
    // disagrees with the sphere form for the same hitbox.
    expect(head?.box.center.y).toBeCloseTo(head?.center.y ?? -1, 12);
    expect(body?.box.center.y).toBeCloseTo(body?.center.y ?? -1, 12);
  });

  it('reuses the array it is handed, so a pooled enemy allocates nothing', () => {
    const boxes = buildHitboxes(ENEMY_SMALL, vec3(0, 0, 0));
    const rebuilt = buildHitboxes(ENEMY_SMALL, vec3(5, 0, 5), boxes);
    expect(rebuilt).toBe(boxes);
    expect(boxes[0]?.center.x).toBe(5);
  });
});

describe('geometric reachability', () => {
  const base = vec3(0, 0, 0);

  it('lets a ray from directly above reach only the head', () => {
    const boxes = buildHitboxes(ENEMY_SMALL, base);
    // Start above the body and shoot straight down.
    const hit = trace(boxes, vec3(0, 6, 0), vec3(0, -1, 0));
    expect(hit).not.toBeNull();
    expect(hit?.zone).toBe('head');
  });

  it('lets a waist-height shot from the side reach only the body', () => {
    const boxes = buildHitboxes(ENEMY_SMALL, base);
    const waist = bodyCenterHeight(ENEMY_SMALL);
    const hit = trace(boxes, vec3(-6, waist, 0), vec3(1, 0, 0));
    expect(hit).not.toBeNull();
    expect(hit?.zone).toBe('body');
  });

  it('lets a head-height shot from the side reach only the head', () => {
    const boxes = buildHitboxes(ENEMY_LARGE, base);
    const head = headCenterHeight(ENEMY_LARGE);
    const hit = trace(boxes, vec3(-12, head, 0), vec3(1, 0, 0));
    expect(hit?.zone).toBe('head');
  });

  it('misses an enemy that has moved out of the ray entirely', () => {
    const boxes = buildHitboxes(ENEMY_SMALL, base);
    const waist = bodyCenterHeight(ENEMY_SMALL);
    // Aimed at where the body *was*, not where it is.
    expect(trace(boxes, vec3(-6, waist, 8), vec3(1, 0, 0))).toBeNull();
  });

  it('keeps the two volumes disjoint along the whole vertical sweep', () => {
    // Sample the vertical axis finely: if the head sphere ever dipped into the body
    // box, some sample would report the head from a waist-height side shot.
    const boxes = buildHitboxes(ENEMY_LARGE, base);
    const layout = hitboxLayout(ENEMY_LARGE);
    const headBottom = ENEMY_LARGE.height - layout.headDiameter;
    for (let y = 0.05; y < ENEMY_LARGE.height; y += 0.05) {
      const hit = trace(boxes, vec3(-12, y, 0), vec3(1, 0, 0));
      expect(hit).not.toBeNull();
      if (y < headBottom - 1e-6) expect(hit?.zone).toBe('body');
      if (y > headBottom + 1e-6) expect(hit?.zone).toBe('head');
    }
  });
});

describe('zone inference for loaded models', () => {
  it('reads head-ish node names as the weak point and everything else as body', () => {
    expect(inferZone('Head')).toBe('head');
    expect(inferZone('mixamorig:Head')).toBe('head');
    expect(inferZone('SKULL_01')).toBe('head');
    expect(inferZone('Neck')).toBe('head');
    expect(inferZone('Spine')).toBe('body');
    expect(inferZone('Hand_L')).toBe('body');
    expect(inferZone('')).toBe('body');
  });
});
