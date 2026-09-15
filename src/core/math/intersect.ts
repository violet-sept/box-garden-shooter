/**
 * Ray and box intersection primitives.
 *
 * The whole hit-detection stack in this project is analytic: a shot is a ray
 * against boxes (level walls, crates) and spheres (targets and enemies). That is
 * a deliberate choice over `three`'s `Raycaster` — it keeps the authoritative
 * hit query inside the simulation layer, where it can be asserted in a unit test
 * with no WebGL context, and it costs a few multiplies per candidate instead of
 * a matrix inversion per object.
 *
 * Every function is allocation-free and tolerates degenerate input (zero-length
 * rays, inside-the-box origins) without producing NaN.
 */

import { type Aabb, type Vector3, clamp } from './vec3';

/** A ray hit. `t` is the distance along the *normalised* direction. */
export interface RayHit {
  /** Distance from the ray origin to the hit point, in metres. */
  t: number;
  /** Surface normal at the hit point, pointing out of the solid. */
  normal: Vector3;
  /** True when the ray started inside the solid. */
  inside: boolean;
}

function makeHit(): RayHit {
  return { t: 0, normal: { x: 0, y: 0, z: 0 }, inside: false };
}

/**
 * Ray against an axis-aligned box (slab method).
 *
 * Returns `null` on a miss, or a filled {@link RayHit}. Note that a ray starting
 * inside the box *does* hit, at `t = 0` with `inside: true` — a muzzle poking
 * through a wall must still report "blocked", which is exactly the case that
 * the "shoot through walls" bug class comes from.
 */
export function rayAabb(out: RayHit, origin: Vector3, direction: Vector3, box: Aabb): RayHit | null {
  let tMin = -Infinity;
  let tMax = Infinity;
  /** Axis of the slab that produced `tMin`, and the outward sign of that face. */
  let entryAxis = -1;

  for (let axis = 0; axis < 3; axis += 1) {
    const o = axis === 0 ? origin.x : axis === 1 ? origin.y : origin.z;
    const d = axis === 0 ? direction.x : axis === 1 ? direction.y : direction.z;
    const c = axis === 0 ? box.center.x : axis === 1 ? box.center.y : box.center.z;
    const h = axis === 0 ? box.halfExtents.x : axis === 1 ? box.halfExtents.y : box.halfExtents.z;

    const lo = c - h;
    const hi = c + h;

    if (Math.abs(d) < 1e-9) {
      // Parallel to this slab: either the ray stays inside the band forever, or
      // it can never enter it.
      if (o < lo || o > hi) return null;
      continue;
    }

    // The two slab crossings. `first` is the one the ray reaches soonest, and
    // `entrySign` is the outward normal of the face it crosses there: the face
    // the ray *enters* through always faces back along the ray, so its sign is
    // `-sign(d)` on this axis. Sorting the two crossings does **not** change which
    // face was entered, so `entrySign` is not touched by the swap below.
    const inv = 1 / d;
    let first = (lo - o) * inv;
    let second = (hi - o) * inv;
    const entrySign = d > 0 ? -1 : 1;
    if (first > second) {
      const swap = first;
      first = second;
      second = swap;
    }

    if (first > tMin) {
      tMin = first;
      entryAxis = axis;
      out.normal.x = 0;
      out.normal.y = 0;
      out.normal.z = 0;
      if (axis === 0) out.normal.x = entrySign;
      else if (axis === 1) out.normal.y = entrySign;
      else out.normal.z = entrySign;
    }
    if (second < tMax) tMax = second;
    if (tMin > tMax) return null;
  }

  // A ray that begins inside the box hits at zero with an undefined face normal,
  // so it is reported as a hit from below: the only case that matters for the
  // camera boom and the ground probe is "you are already in the wall".
  const inside = tMin < 0;
  out.t = inside ? 0 : tMin;
  out.inside = inside;
  if (inside || entryAxis < 0) {
    out.normal.x = 0;
    out.normal.y = 1;
    out.normal.z = 0;
  }
  return out;
}

/** Ray against a sphere. Returns `null` on a miss or when the sphere is behind. */
export function raySphere(
  out: RayHit,
  origin: Vector3,
  direction: Vector3,
  center: Vector3,
  radius: number,
): RayHit | null {
  const ox = origin.x - center.x;
  const oy = origin.y - center.y;
  const oz = origin.z - center.z;

  const a = direction.x * direction.x + direction.y * direction.y + direction.z * direction.z;
  if (a < 1e-12) return null;

  const b = 2 * (ox * direction.x + oy * direction.y + oz * direction.z);
  const c = ox * ox + oy * oy + oz * oz - radius * radius;

  if (c <= 0) {
    // Origin inside the sphere.
    out.t = 0;
    out.inside = true;
    out.normal.x = -direction.x;
    out.normal.y = -direction.y;
    out.normal.z = -direction.z;
    return out;
  }

  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;

  const sqrtDisc = Math.sqrt(disc);
  const t = (-b - sqrtDisc) / (2 * a);
  if (t < 0) return null;

  out.t = t;
  out.inside = false;
  const invLen = 1 / Math.sqrt(a);
  out.normal.x = (origin.x + direction.x * t - center.x) / radius;
  out.normal.y = (origin.y + direction.y * t - center.y) / radius;
  out.normal.z = (origin.z + direction.z * t - center.z) / radius;
  // Guard against a zero-length direction producing a non-unit normal.
  if (!Number.isFinite(out.normal.x) || invLen === 0) {
    out.normal.x = 0;
    out.normal.y = 1;
    out.normal.z = 0;
  }
  return out;
}

/** Nearest point on (or inside) a box to a given point. */
export function closestPointOnAabb(out: Vector3, point: Vector3, box: Aabb): Vector3 {
  out.x = clamp(point.x, box.center.x - box.halfExtents.x, box.center.x + box.halfExtents.x);
  out.y = clamp(point.y, box.center.y - box.halfExtents.y, box.center.y + box.halfExtents.y);
  out.z = clamp(point.z, box.center.z - box.halfExtents.z, box.center.z + box.halfExtents.z);
  return out;
}

/** True when the point lies inside the box (inclusive of the surface). */
export function pointInAabb(point: Vector3, box: Aabb): boolean {
  return (
    Math.abs(point.x - box.center.x) <= box.halfExtents.x &&
    Math.abs(point.y - box.center.y) <= box.halfExtents.y &&
    Math.abs(point.z - box.center.z) <= box.halfExtents.z
  );
}

/**
 * Overlap test between a sphere and an axis-aligned box.
 *
 * Used by the melee hit path (technical plan §3.2.5): a contact attack is more
 * forgiving as a volume overlap than as a ray, which is what stops "it clearly
 * touched me and nothing happened".
 */
export function sphereIntersectsAabb(center: Vector3, radius: number, box: Aabb): boolean {
  const dx = Math.max(Math.abs(center.x - box.center.x) - box.halfExtents.x, 0);
  const dy = Math.max(Math.abs(center.y - box.center.y) - box.halfExtents.y, 0);
  const dz = Math.max(Math.abs(center.z - box.center.z) - box.halfExtents.z, 0);
  return dx * dx + dy * dy + dz * dz <= radius * radius;
}

/**
 * Overlap test between a moving point's **swept segment** and an axis-aligned box.
 *
 * This is the primitive the Warden's shot uses, and the reason it is a segment rather
 * than a point is tunnelling: at 24 m/s a shot covers 0.4 m per 60 Hz tick, so testing
 * "is the projectile inside the player now" would let it pass clean through a body
 * between two ticks — the classic fast-projectile miss, and one the player would read as
 * "that clearly went through me and nothing happened".
 *
 * The parameters are the two ends of the tick's travel rather than an origin and a
 * direction, because that is what the caller has and it keeps the tolerance explicit:
 * `t ∈ [0, 1]` is exactly "during this tick". Starting inside the box counts as a hit,
 * which is what makes the test symmetric with {@link sphereIntersectsAabb}.
 *
 * Allocation-free and NaN-tolerant in the same way {@link rayAabb} is.
 */
export function segmentIntersectsAabb(from: Vector3, to: Vector3, box: Aabb): boolean {
  let tMin = 0;
  let tMax = 1;

  for (let axis = 0; axis < 3; axis += 1) {
    const o = axis === 0 ? from.x : axis === 1 ? from.y : from.z;
    const d = axis === 0 ? to.x - from.x : axis === 1 ? to.y - from.y : to.z - from.z;
    const c = axis === 0 ? box.center.x : axis === 1 ? box.center.y : box.center.z;
    const h = axis === 0 ? box.halfExtents.x : axis === 1 ? box.halfExtents.y : box.halfExtents.z;

    const lo = c - h;
    const hi = c + h;

    if (Math.abs(d) < 1e-9) {
      // Parallel to this slab: the segment stays inside the band or it can never enter it.
      if (o < lo || o > hi) return false;
      continue;
    }

    const inv = 1 / d;
    let first = (lo - o) * inv;
    let second = (hi - o) * inv;
    if (first > second) {
      const swap = first;
      first = second;
      second = swap;
    }
    if (first > tMin) tMin = first;
    if (second < tMax) tMax = second;
    if (tMin > tMax) return false;
  }

  return true;
}

/**
 * Resolves a vertical capsule out of a box and reports the correction.
 *
 * Separating-axis-lite: the shallowest of the three axis overlaps is the one
 * that un-collides the capsule with the least disturbance, which is what makes a
 * player slide along a wall instead of being ejected sideways from it.
 * The capsule is treated as a vertical segment of zero radius plus a horizontal
 * radius, which is exact for a cylinder and cheap enough to run per obstacle.
 */
export interface PenetrationResult {
  /** Minimum translation that moves the capsule out of the box. */
  correction: Vector3;
  /** Unit normal of the resolved face. */
  normal: Vector3;
  /** Penetration depth along `normal`. */
  depth: number;
}

export function resolveCapsuleAabb(
  out: PenetrationResult,
  base: Vector3,
  radius: number,
  height: number,
  box: Aabb,
): boolean {
  // Nearest point on the box to the capsule's vertical axis segment.
  const segX = clamp(base.x, box.center.x - box.halfExtents.x, box.center.x + box.halfExtents.x);
  const segZ = clamp(base.z, box.center.z - box.halfExtents.z, box.center.z + box.halfExtents.z);
  const segY = clamp(base.y + height * 0.5, box.center.y - box.halfExtents.y, box.center.y + box.halfExtents.y);

  const dx = base.x - segX;
  const dy = base.y + height * 0.5 - segY;
  const dz = base.z - segZ;

  const c = box.center;
  const h = box.halfExtents;

  // Distance to each face along each axis, treating the capsule as a box of
  // half-extents (radius, height/2, radius). Standard AABB-vs-AABB MTV.
  const overlapX = h.x + radius - Math.abs(base.x - c.x);
  const overlapY = h.y + height * 0.5 - Math.abs(base.y + height * 0.5 - c.y);
  const overlapZ = h.z + radius - Math.abs(base.z - c.z);

  if (overlapX <= 0 || overlapY <= 0 || overlapZ <= 0) return false;
  // The `dx/dy/dz` terms above are unused for the MTV itself but document the
  // contact point; keep the computation honest by exiting early when separated.
  void dx;
  void dy;
  void dz;

  if (overlapX <= overlapY && overlapX <= overlapZ) {
    const sign = Math.sign(base.x - c.x) || 1;
    out.correction.x = overlapX * sign;
    out.correction.y = 0;
    out.correction.z = 0;
    out.normal.x = sign;
    out.normal.y = 0;
    out.normal.z = 0;
    out.depth = overlapX;
  } else if (overlapY <= overlapZ) {
    const sign = Math.sign(base.y + height * 0.5 - c.y) || 1;
    out.correction.x = 0;
    out.correction.y = overlapY * sign;
    out.correction.z = 0;
    out.normal.x = 0;
    out.normal.y = sign;
    out.normal.z = 0;
    out.depth = overlapY;
  } else {
    const sign = Math.sign(base.z - c.z) || 1;
    out.correction.x = 0;
    out.correction.y = 0;
    out.correction.z = overlapZ * sign;
    out.normal.x = 0;
    out.normal.y = 0;
    out.normal.z = sign;
    out.depth = overlapZ;
  }
  return true;
}

/** Creates a reusable {@link RayHit} so hot loops never allocate. */
export function createRayHit(): RayHit {
  return makeHit();
}

/** Convenience constructor for a box literal, mostly for tests and level data. */
export function aabb(
  x: number,
  y: number,
  z: number,
  halfX: number,
  halfY: number,
  halfZ: number,
): Aabb {
  return { center: { x, y, z }, halfExtents: { x: halfX, y: halfY, z: halfZ } };
}

/** Box built from its minimum and maximum corners. */
export function aabbFromMinMax(min: Vector3, max: Vector3): Aabb {
  return {
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
    halfExtents: {
      x: Math.abs(max.x - min.x) / 2,
      y: Math.abs(max.y - min.y) / 2,
      z: Math.abs(max.z - min.z) / 2,
    },
  };
}
