/**
 * Analytic multi-part hitboxes.
 *
 * Two body parts per enemy — `head` (the weak point) and `body` — built from
 * `EnemyStats.radius` / `EnemyStats.height` alone. The mesh plays no part in this:
 * swapping in a supplied `.glb` must not move where the shots land, and a
 * hitbox stack derived from a model's vertex bounds is exactly how "the visual
 * and the hitbox are out of step after a model update" happens.
 *
 * This replaces the phase-1 practice-dummy equivalent in `game/targets.ts`. The
 * shape is deliberately the same one (`hitboxes[0]` is always the head) because
 * the shot resolver reads that contract positionally.
 */

import { ENEMY, type EnemyStats } from '../../core/config';
import type { Aabb, Vector3 } from '../../core/math/vec3';
import type { HitZone } from '../../core/events';

/** One damageable body part, in simulation space. */
export interface TargetHitbox {
  readonly zone: HitZone;
  /** Radius for the sphere form, or the body radius for the box form. */
  readonly shape: 'sphere' | 'box';
  readonly center: Vector3;
  readonly radius: number;
  readonly box: Aabb;
}

/** The derived vertical layout of one enemy body. */
export interface HitboxLayout {
  /** Diameter of the head sphere, in metres. */
  readonly headDiameter: number;
  readonly headRadius: number;
  /** Vertical extent of the body box, from the feet up to the neck. */
  readonly bodyHeight: number;
  readonly bodyRadius: number;
}

/**
 * Derives head/body proportions from an archetype's collision capsule.
 *
 * The head's *top* is placed exactly at `height`, so the capsule the movement
 * solver keeps out of crates is the same silhouette the player is shooting at.
 * Anything else produces the classic "my bullets go over its head" report that is
 * really a hitbox that is 20 cm short.
 */
export function hitboxLayout(stats: EnemyStats): HitboxLayout {
  const height = Math.max(0, stats.height);
  const radius = Math.max(0, stats.radius);
  // Very short enemies get no head at all rather than an inverted one: a head
  // radius larger than a third of the body would put the weak point *below* the
  // shoulders, which reads as a hitbox bug.
  const headDiameter = height * ENEMY.headFraction >= height * ENEMY.minHeadFraction
    ? height * ENEMY.headFraction
    : 0;
  const headRadius = headDiameter / 2;
  return {
    headDiameter,
    headRadius,
    bodyHeight: Math.max(0, height - headDiameter),
    bodyRadius: radius,
  };
}

/** Vertical centre of the head sphere, in local space (feet at y = 0). */
export function headCenterHeight(stats: EnemyStats): number {
  return stats.height - hitboxLayout(stats).headRadius;
}

/** Vertical centre of the body box, in local space. */
export function bodyCenterHeight(stats: EnemyStats): number {
  return hitboxLayout(stats).bodyHeight / 2;
}

/**
 * Builds the head/body hitbox stack for one enemy.
 *
 * `hitboxes[0]` is always the head. The positions are recomputed from the feet
 * position by {@link syncHitboxes} every tick, so this is only ever the initial
 * placement.
 *
 * @param out Optional array to fill in place, so a pooled enemy allocates nothing
 *            when it is recycled. Pass nothing to get a fresh pair.
 */
export function buildHitboxes(stats: EnemyStats, base: Vector3, out?: TargetHitbox[]): TargetHitbox[] {
  const layout = hitboxLayout(stats);
  const boxes = out ?? [];
  if (boxes.length !== 2) {
    boxes.length = 0;
    boxes.push(
      {
        zone: 'head',
        shape: 'sphere',
        center: { x: base.x, y: base.y + stats.height - layout.headRadius, z: base.z },
        radius: layout.headRadius,
        box: {
          center: { x: base.x, y: base.y + stats.height - layout.headRadius, z: base.z },
          halfExtents: { x: layout.headRadius, y: layout.headRadius, z: layout.headRadius },
        },
      },
      {
        zone: 'body',
        shape: 'box',
        center: { x: base.x, y: base.y + layout.bodyHeight / 2, z: base.z },
        radius: layout.bodyRadius,
        box: {
          center: { x: base.x, y: base.y + layout.bodyHeight / 2, z: base.z },
          halfExtents: { x: layout.bodyRadius, y: layout.bodyHeight / 2, z: layout.bodyRadius },
        },
      },
    );
    return boxes;
  }
  syncHitboxes(boxes, stats, base);
  return boxes;
}

/**
 * Moves an existing hitbox stack to a new feet position.
 *
 * Writes through the existing objects rather than rebuilding: this runs for every
 * enemy every tick, and at 14 enemies x 2 parts x 60 Hz a rebuild is 100 800
 * objects a minute for no benefit.
 */
export function syncHitboxes(boxes: TargetHitbox[], stats: EnemyStats, base: Vector3): void {
  const layout = hitboxLayout(stats);
  const headY = base.y + stats.height - layout.headRadius;
  const bodyY = base.y + layout.bodyHeight / 2;

  for (const hitbox of boxes) {
    const y = hitbox.zone === 'head' ? headY : bodyY;
    hitbox.center.x = base.x;
    hitbox.center.y = y;
    hitbox.center.z = base.z;
    hitbox.box.center.x = base.x;
    hitbox.box.center.y = y;
    hitbox.box.center.z = base.z;
  }
}

/**
 * Guesses a hit zone from a model node's name.
 *
 * Only used by the GLTF loader, which has nothing else to go on. The analytic
 * stack above stays authoritative for shots; this exists so a loaded model's
 * per-mesh layer assignment has a zone to report to the debug overlay.
 */
export function inferZone(nodeName: string): HitZone {
  const name = nodeName.toLowerCase();
  return /head|skull|cranium|neck/.test(name) ? 'head' : 'body';
}
