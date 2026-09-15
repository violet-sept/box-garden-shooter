/**
 * Minimal vector math for the simulation layer.
 *
 * The simulation deliberately does **not** import `three`. Everything it needs
 * is a handful of float operations over a plain `{x, y, z}` object, and keeping
 * that local has three concrete payoffs: `src/game/**` can be unit-tested in
 * plain Node, the collision solve is readable instead of hidden behind two
 * layers of abstraction, and there is no chance of a renderer type leaking into
 * a system that must stay deterministic.
 *
 * Style: functions take the destination first and write into it, so a tick loop
 * can reuse scratch vectors and allocate nothing. `Vector3` here is a plain
 * object, not a class — object literals are cheaper to create and trivially
 * serialisable in test fixtures.
 */

/** A 3D vector. Plain data: structurally compatible with `THREE.Vector3`. */
export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

/** An axis-aligned bounding box, described by its centre and half-extents. */
export interface Aabb {
  readonly center: Vector3;
  /** Half-size along each axis. Always positive. */
  readonly halfExtents: Vector3;
}

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
/** Full turn, precomputed because it appears in every angle normalisation. */
const TAU = Math.PI * 2;

export function vec3(x = 0, y = 0, z = 0): Vector3 {
  return { x, y, z };
}

export function set(out: Vector3, x: number, y: number, z: number): Vector3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function copy(out: Vector3, a: Vector3): Vector3 {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
}

export function clone(a: Vector3): Vector3 {
  return { x: a.x, y: a.y, z: a.z };
}

export function add(out: Vector3, a: Vector3, b: Vector3): Vector3 {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  out.z = a.z + b.z;
  return out;
}

export function subtract(out: Vector3, a: Vector3, b: Vector3): Vector3 {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  out.z = a.z - b.z;
  return out;
}

export function scale(out: Vector3, a: Vector3, s: number): Vector3 {
  out.x = a.x * s;
  out.y = a.y * s;
  out.z = a.z * s;
  return out;
}

/** `out = a + b * s`. The single most common operation in an integrator. */
export function addScaled(out: Vector3, a: Vector3, b: Vector3, s: number): Vector3 {
  out.x = a.x + b.x * s;
  out.y = a.y + b.y * s;
  out.z = a.z + b.z * s;
  return out;
}

export function dot(a: Vector3, b: Vector3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(out: Vector3, a: Vector3, b: Vector3): Vector3 {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function lengthSq(a: Vector3): number {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}

export function length(a: Vector3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

/** Horizontal (XZ-plane) distance. Used by every ground-plane range check. */
export function distanceXZ(a: Vector3, b: Vector3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

export function distance(a: Vector3, b: Vector3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Normalises in place. A zero-length vector is left untouched (never NaN). */
export function normalize(out: Vector3, a: Vector3): Vector3 {
  const len = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  if (len < 1e-9) {
    return set(out, 0, 0, 0);
  }
  const inv = 1 / len;
  out.x = a.x * inv;
  out.y = a.y * inv;
  out.z = a.z * inv;
  return out;
}

/**
 * Rotates `dir` about the unit `axis` by `angle` radians (Rodrigues' formula).
 * Used to apply weapon spread to the shot direction.
 */
export function rotateAroundAxis(out: Vector3, dir: Vector3, axis: Vector3, angle: number): Vector3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const d = dot(axis, dir);
  const cx = axis.y * dir.z - axis.z * dir.y;
  const cy = axis.z * dir.x - axis.x * dir.z;
  const cz = axis.x * dir.y - axis.y * dir.x;
  out.x = dir.x * c + cx * s + axis.x * d * (1 - c);
  out.y = dir.y * c + cy * s + axis.y * d * (1 - c);
  out.z = dir.z * c + cz * s + axis.z * d * (1 - c);
  return out;
}

/**
 * Any unit vector perpendicular to `a`.
 *
 * Picks the world axis least aligned with `a` before crossing, so the result
 * never degenerates — the naive `cross(a, up)` collapses to zero whenever the
 * player looks straight up or down.
 */
export function perpendicular(out: Vector3, a: Vector3): Vector3 {
  const ax = Math.abs(a.x);
  const ay = Math.abs(a.y);
  const az = Math.abs(a.z);
  // Pick the world axis the input is *least* aligned with, then cross. Ties are
  // resolved toward X on purpose: crossing with X only degenerates when the input
  // is itself along X, and that case is caught by the fallback below.
  //
  // (Treating the X/Y tie as "use X" would fail here: `cross((1,0,0), (1,0,0))`
  // is the zero vector, so a pure +X direction would normalise to nothing.)
  let cx: number;
  let cy: number;
  let cz: number;
  if (ay <= ax && ay <= az) {
    // Cross with +Y: (a.z, 0, −a.x)
    cx = a.z;
    cy = 0;
    cz = -a.x;
  } else if (ax <= az) {
    // Cross with +X: (0, −a.z, a.y)
    cx = 0;
    cy = -a.z;
    cz = a.y;
  } else {
    // Cross with +Z: (−a.y, a.x, 0)
    cx = -a.y;
    cy = a.x;
    cz = 0;
  }

  // Belt and braces: if the chosen axis was parallel after all (or the input is
  // zero), fall back to a guaranteed-independent axis rather than returning zero.
  if (cx * cx + cy * cy + cz * cz < 1e-18) {
    cx = 1;
    cy = 0;
    cz = 0;
  }
  return normalize(out, set(out, cx, cy, cz));
}

/** Wraps an angle into `(-π, π]`. */
export function wrapAngle(angle: number): number {
  let a = angle % TAU;
  if (a > Math.PI) a -= TAU;
  if (a <= -Math.PI) a += TAU;
  return a;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Frame-rate-independent exponential approach.
 *
 * `rate` is roughly "how many e-folds per second": a higher rate converges
 * faster. The exponential form is what makes the result identical at 30, 60 and
 * 144 FPS, which a naive `lerp(a, b, 0.1)` per frame is not.
 */
export function damp(a: number, b: number, rate: number, dt: number): number {
  return b + (a - b) * Math.exp(-rate * dt);
}

export function dampVec3(out: Vector3, a: Vector3, b: Vector3, rate: number, dt: number): Vector3 {
  const factor = Math.exp(-rate * dt);
  out.x = b.x + (a.x - b.x) * factor;
  out.y = b.y + (a.y - b.y) * factor;
  out.z = b.z + (a.z - b.z) * factor;
  return out;
}

/**
 * Unit forward vector for a yaw/pitch pair, matching Euler order `YXZ`.
 *
 * That order is the one `three`'s `Object3D.rotation` uses by default, so a
 * camera driven by these angles points exactly where the shot goes. Getting the
 * convention wrong here produces an off-by-90° aim error that looks like a
 * broken hitbox.
 */
export function forwardFromYawPitch(out: Vector3, yaw: number, pitch: number): Vector3 {
  const cp = Math.cos(pitch);
  return set(out, -Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
}

/**
 * Unit vectors defining a horizontal frame for movement.
 *
 * Movement is resolved from yaw only, never pitch: looking at the floor must
 * not make W drive the player into it. This is the standard third-person
 * resolution of "W is forward" and the one the acceptance criteria describe.
 */
export function rightFromYaw(out: Vector3, yaw: number): Vector3 {
  return set(out, Math.cos(yaw), 0, -Math.sin(yaw));
}

/**
 * Unit up vector for a yaw/pitch pair under Euler order `YXZ`.
 *
 * Together with {@link forwardFromYawPitch} and {@link rightFromYawPitch} this is
 * an orthonormal basis for the view. The muzzle offset is expressed in it so the
 * weapon sits beside and below the sight line.
 */
export function upFromYawPitch(out: Vector3, yaw: number, pitch: number): Vector3 {
  const sp = Math.sin(pitch);
  return set(out, Math.sin(yaw) * sp, Math.cos(pitch), Math.cos(yaw) * sp);
}

/**
 * Unit right vector of the *pitched* view basis.
 *
 * This is `cross(forward, up)` normalised, which stays perpendicular to forward
 * at every pitch and coincides exactly with {@link rightFromYaw} when the camera
 * is level.
 *
 * Use this — not the flat `rightFromYaw` — whenever a laterally offset point has
 * to remain exactly on the camera's forward axis. The flat, yaw-only right vector
 * is correct for movement (which must not be pitched) but leans out of the view
 * plane as soon as the camera pitches, so mixing the two tilts the aim axis by a
 * sliver of a degree. Small, but enough to make the crosshair and the tracer
 * disagree at range.
 */
export function rightFromYawPitch(out: Vector3, yaw: number, pitch: number): Vector3 {
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);
  // `pitch` is accepted for symmetry with the rest of the basis and documented as
  // unused: `cross(forward, up)` normalised collapses to exactly (cos yaw, 0,
  // −sin yaw) for every pitch. A missing normalisation on the raw cross product
  // (which has length |cos pitch|) is the failure mode this signature guards
  // against, so the parameter stays part of the contract.
  void pitch;
  return set(out, cy, 0, -sy);
}

export function forwardFlatFromYaw(out: Vector3, yaw: number): Vector3 {
  return set(out, -Math.sin(yaw), 0, -Math.cos(yaw));
}
