/**
 * Steering behaviours.
 *
 * Every function writes into an `out` vector and allocates nothing, because these
 * are called once per enemy per tick and a single object literal per call would
 * be 50 400 allocations a minute at the concurrent-enemy cap.
 *
 * Two deliberate limitations:
 *
 *   - **No pathfinding.** The arena is an open diorama with hand-placed cover, so
 *     seek plus obstacle resolution is enough. A navmesh is explicitly out of
 *     scope for this phase.
 *   - **No avoidance of the level.** These produce a *desired* velocity. Pushing
 *     that through `resolveCapsuleAabb` is what keeps enemies out of crates, and
 *     keeping the two jobs separate is what stops the steerer from fighting the
 *     collision solver.
 *
 * ## Units
 *
 * The `maxSpeed` passed in is a *speed*, and every output is bounded by it. That
 * invariant is what makes "enemies never move faster than their configured
 * speed" an assertion rather than a hope, and it is why {@link clampSpeed} exists
 * as the single funnel for combined steering.
 */

import { type Vector3, distanceXZ, set } from '../../core/math/vec3';

/**
 * Caps a vector's length at `maxSpeed`, in place.
 *
 * The only place a speed limit is applied, so "the enemy outran its config" has
 * exactly one candidate. A zero-length vector stays zero rather than becoming NaN.
 */
export function clampSpeed(out: Vector3, maxSpeed: number): Vector3 {
  const limit = Math.max(0, maxSpeed);
  const lengthSq = out.x * out.x + out.y * out.y + out.z * out.z;
  if (lengthSq <= limit * limit || lengthSq === 0) return out;
  const scale = limit / Math.sqrt(lengthSq);
  out.x *= scale;
  out.y *= scale;
  out.z *= scale;
  return out;
}

/**
 * Velocity that closes on `target` at full speed, on the horizontal plane.
 *
 * Horizontal distance only: enemies do not fly, and a seek that includes the
 * player's height would make an enemy standing under a platform try to climb it.
 */
export function seek(out: Vector3, self: Vector3, target: Vector3, maxSpeed: number): Vector3 {
  const dx = target.x - self.x;
  const dz = target.z - self.z;
  const length = Math.hypot(dx, dz);
  if (length < 1e-6) return set(out, 0, 0, 0);
  const speed = Math.max(0, maxSpeed);
  out.x = (dx / length) * speed;
  out.y = 0;
  out.z = (dz / length) * speed;
  return out;
}

/**
 * Seek that eases to a stop inside `slowRadius`, so an enemy does not overshoot
 * its target and oscillate around it.
 *
 * The speed ramp is linear in distance (`speed = maxSpeed * d / slowRadius`),
 * which reaches exactly zero *at* the target rather than approaching it
 * asymptotically. That matters for the assertion "arrive does not overshoot": an
 * exponential ramp never quite arrives, so a test on final distance would have to
 * accept a tolerance, while a linear one finishes.
 */
export function arrive(
  out: Vector3,
  self: Vector3,
  target: Vector3,
  maxSpeed: number,
  slowRadius: number,
): Vector3 {
  const dx = target.x - self.x;
  const dz = target.z - self.z;
  const length = Math.hypot(dx, dz);
  if (length < 1e-6) return set(out, 0, 0, 0);
  const radius = Math.max(slowRadius, 1e-6);
  const speed = Math.max(0, maxSpeed) * Math.min(1, length / radius);
  out.x = (dx / length) * speed;
  out.y = 0;
  out.z = (dz / length) * speed;
  return out;
}

/**
 * Push away from nearby bodies, so a pack does not collapse into one silhouette.
 *
 * Sums a `1/d` repulsion from every neighbour inside `radius`. The inverse form
 * (rather than inverse-square) is deliberate: it is bounded as `d → 0` once the
 * zero-distance case is handled, which is what keeps two exactly-coincident
 * enemies from producing an infinite force — and, from there, a NaN position.
 *
 * **Zero distance is resolved onto a deterministic axis** rather than randomly,
 * so a seeded run stays reproducible: two enemies spawned on the same point
 * always separate along +X first.
 *
 * @param strength Push magnitude at zero distance, in m/s.
 */
export function separation(
  out: Vector3,
  self: Vector3,
  neighbours: readonly Vector3[],
  radius: number,
  strength: number,
): Vector3 {
  let pushX = 0;
  let pushZ = 0;
  const range = Math.max(radius, 1e-6);

  for (const neighbour of neighbours) {
    if (neighbour === self) continue;
    const dx = self.x - neighbour.x;
    const dz = self.z - neighbour.z;
    const distanceSq = dx * dx + dz * dz;
    if (distanceSq > range * range) continue;

    if (distanceSq < 1e-8) {
      // Exactly coincident: a deterministic nudge, never a division by zero.
      pushX += strength;
      continue;
    }
    const distance = Math.sqrt(distanceSq);
    // Linear falloff to zero at the edge of the radius: a hard cutoff is felt as
    // a jolt the moment a neighbour enters range.
    const weight = (1 - distance / range) * strength;
    pushX += (dx / distance) * weight;
    pushZ += (dz / distance) * weight;
  }

  return set(out, pushX, 0, pushZ);
}

/**
 * Velocity that holds a range band: approach when too far, retreat when too
 * close, and stay put in between.
 *
 * The two thresholds are separate from the band's edges so the Warden does not
 * jitter on the boundary — a single threshold makes it oscillate between
 * advancing and retreating every tick, which reads as an animation bug.
 *
 * `strafe` is added as a lateral component (a right-hand perpendicular to the
 * line to the player), which is what makes the Warden look like it is stalking
 * rather than standing still while it waits out its cooldown.
 */
export function keepDistance(
  out: Vector3,
  self: Vector3,
  target: Vector3,
  min: number,
  max: number,
  maxSpeed?: number,
  strafe = 0,
): Vector3 {
  const dx = target.x - self.x;
  const dz = target.z - self.z;
  const distance = Math.hypot(dx, dz);
  const speed = Math.max(0, maxSpeed ?? 0);

  if (distance < 1e-6) return set(out, 0, 0, 0);

  const dirX = dx / distance;
  const dirZ = dz / distance;

  let radial = 0;
  if (distance > max) {
    // Closing: full speed outside the band, easing in as it reaches the edge.
    radial = Math.min(1, (distance - max) / Math.max(max - min, 1e-6));
  } else if (distance < min) {
    // Backing off, again eased so it settles onto the band's inner edge.
    radial = -Math.min(1, (min - distance) / Math.max(max - min, 1e-6));
  }

  // Lateral direction is `cross(up, dir)` on the horizontal plane.
  const rightX = -dirZ;
  const rightZ = dirX;

  out.x = dirX * radial * speed + rightX * strafe;
  out.y = 0;
  out.z = dirZ * radial * speed + rightZ * strafe;
  return out;
}

/** Horizontal distance, re-exported so enemy modules do not reach past this one. */
export { distanceXZ };
