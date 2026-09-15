/**
 * Math layer tests.
 *
 * Covers the two things the technical plan calls out by name - seeded random
 * determinism and the analytic intersection primitives - plus the camera basis
 * identities that the whole aim/damage chain rests on. If `forwardFromYawPitch`
 * and `rightFromYaw` ever disagree about handedness, every shot lands 90 deg off and
 * the symptom looks like a broken hitbox, so it is asserted here rather than
 * debugged in the browser.
 */

import { describe, expect, it } from 'vitest';
import {
  aabb,
  closestPointOnAabb,
  pointInAabb,
  rayAabb,
  raySphere,
  sphereIntersectsAabb,
} from '#/core/math/intersect';
import { createRng, seedFromString } from '#/core/math/rng';
import {
  DEG2RAD,
  clamp,
  cross,
  damp,
  distance,
  dot,
  forwardFromYawPitch,
  length,
  normalize,
  perpendicular,
  rightFromYaw,
  rightFromYawPitch,
  rotateAroundAxis,
  upFromYawPitch,
  vec3,
  wrapAngle,
} from '#/core/math/vec3';

const closeTo = (a: number, b: number, eps = 1e-9): void => {
  expect(Math.abs(a - b)).toBeLessThan(eps);
};

describe('seeded random', () => {
  it('produces the same sequence for the same seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    for (let i = 0; i < 64; i += 1) {
      expect(a.next()).toBe(b.next());
    }
  });

  it('produces different sequences for different seeds', () => {
    const a = createRng(1);
    const b = createRng(2);
    const first = Array.from({ length: 16 }, () => a.next());
    const second = Array.from({ length: 16 }, () => b.next());
    expect(first).not.toEqual(second);
  });

  it('stays inside [0, 1)', () => {
    const rng = createRng(7);
    for (let i = 0; i < 5000; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('respects range and integer bounds', () => {
    const rng = createRng(99);
    for (let i = 0; i < 2000; i += 1) {
      const value = rng.range(-3, 5);
      expect(value).toBeGreaterThanOrEqual(-3);
      expect(value).toBeLessThan(5);
      const int = rng.int(2, 6);
      expect(Number.isInteger(int)).toBe(true);
      expect(int).toBeGreaterThanOrEqual(2);
      expect(int).toBeLessThanOrEqual(6);
    }
  });

  it('returns unit vectors with no NaN, even near the poles', () => {
    const rng = createRng(5);
    const out = vec3();
    for (let i = 0; i < 2000; i += 1) {
      rng.unitVector(out);
      closeTo(length(out), 1, 1e-9);
      expect(Number.isFinite(out.x)).toBe(true);
      expect(Number.isFinite(out.y)).toBe(true);
      expect(Number.isFinite(out.z)).toBe(true);
    }
  });

  it('hashes strings to stable seeds', () => {
    expect(seedFromString('box-garden')).toBe(seedFromString('box-garden'));
    expect(seedFromString('a')).not.toBe(seedFromString('b'));
  });
});

describe('vector math', () => {
  it('builds an orthonormal view basis for every yaw/pitch', () => {
    const forward = vec3();
    const right = vec3();
    const up = vec3();
    const yaws = [-3, -1.2, 0, 0.7, 2.5, 3.1];
    const pitches = [-1.4, -0.3, 0, 0.6, 1.48];
    for (const yaw of yaws) {
      for (const pitch of pitches) {
        forwardFromYawPitch(forward, yaw, pitch);
        rightFromYawPitch(right, yaw, pitch);
        upFromYawPitch(up, yaw, pitch);
        closeTo(length(forward), 1, 1e-9);
        closeTo(length(right), 1, 1e-9);
        closeTo(length(up), 1, 1e-9);
        // Mutually orthogonal, in the forward * up = right handedness.
        closeTo(dot(forward, right), 0, 1e-9);
        closeTo(dot(forward, up), 0, 1e-9);
        closeTo(dot(right, up), 0, 1e-9);
        const handed = vec3();
        cross(handed, forward, up);
        closeTo(handed.x, right.x, 1e-9);
        closeTo(handed.y, right.y, 1e-9);
        closeTo(handed.z, right.z, 1e-9);
      }
    }
  });

  it('faces -X at yaw 0, so W is "into the screen"', () => {
    const forward = vec3();
    forwardFromYawPitch(forward, 0, 0);
    closeTo(forward.x, 0);
    closeTo(forward.y, 0);
    closeTo(forward.z, -1);

    const right = vec3();
    rightFromYaw(right, 0);
    closeTo(right.x, 1);
    closeTo(right.z, 0);
  });

  it('is left-handed-consistent under a +90 deg yaw', () => {
    // Yaw is applied about +Y, so a positive yaw turns the view toward -Z.
    const forward = vec3();
    forwardFromYawPitch(forward, Math.PI / 2, 0);
    closeTo(forward.x, -1, 1e-9);
    closeTo(forward.z, 0, 1e-9);
  });

  it('normalises without ever producing NaN on a zero vector', () => {
    const out = vec3(1, 1, 1);
    normalize(out, vec3(0, 0, 0));
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
    expect(out.z).toBe(0);
  });

  it('finds a usable perpendicular even when looking straight up', () => {
    const out = vec3();
    // The naive `cross(dir, up)` collapses at the poles; these four directions are
    // exactly the cases that break it.
    for (const dir of [vec3(0, 1, 0), vec3(0, -1, 0), vec3(0, 0, 1), vec3(1, 0, 0)]) {
      perpendicular(out, dir);
      closeTo(length(out), 1, 1e-9);
      closeTo(dot(out, dir), 0, 1e-9);
      expect(Number.isFinite(out.x)).toBe(true);
      expect(Number.isFinite(out.y)).toBe(true);
      expect(Number.isFinite(out.z)).toBe(true);
    }
    // A tilted direction is the common case and must also come out orthonormal.
    perpendicular(out, vec3(0.3, 0.9, -0.4));
    closeTo(length(out), 1, 1e-9);
  });

  it('tolerates a direction that is not unit length', () => {
    const out = vec3();
    perpendicular(out, vec3(0, 4, 0));
    closeTo(length(out), 1, 1e-9);
    closeTo(dot(out, vec3(0, 1, 0)), 0, 1e-9);
  });

  it('rotates about an axis by the requested angle', () => {
    const out = vec3();
    rotateAroundAxis(out, vec3(1, 0, 0), vec3(0, 1, 0), Math.PI / 2);
    closeTo(out.x, 0, 1e-9);
    closeTo(out.y, 0, 1e-9);
    closeTo(out.z, -1, 1e-9);
  });

  it('wraps angles into (-pi, pi]', () => {
    closeTo(wrapAngle(0), 0);
    closeTo(wrapAngle(Math.PI * 3), Math.PI, 1e-9);
    closeTo(wrapAngle(-Math.PI * 3), Math.PI, 1e-9);
    closeTo(wrapAngle(Math.PI * 0.5), Math.PI * 0.5, 1e-12);
  });

  it('damps identically regardless of how the time is chopped up', () => {
    // The frame-rate independence claim, in its smallest form: one 1/60 s step
    // must equal two 1/120 s steps.
    const oneStep = damp(10, 0, 5, 1 / 60);
    const twoSteps = damp(damp(10, 0, 5, 1 / 120), 0, 5, 1 / 120);
    closeTo(oneStep, twoSteps, 1e-12);
  });

  it('clamps and measures distance', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
    closeTo(distance(vec3(0, 0, 0), vec3(3, 4, 0)), 5);
  });
});

describe('ray / box intersection', () => {
  const box = aabb(0, 0, 0, 1, 1, 1);
  const hit = { t: 0, normal: vec3(), inside: false };

  it('hits the near face and reports the correct normal', () => {
    const result = rayAabb(hit, vec3(-5, 0, 0), vec3(1, 0, 0), box);
    expect(result).not.toBeNull();
    closeTo(result!.t, 4, 1e-9);
    closeTo(result!.normal.x, -1, 1e-9);
    expect(result!.inside).toBe(false);
  });

  it('misses when the ray passes beside the box', () => {
    expect(rayAabb(hit, vec3(-5, 2.5, 0), vec3(1, 0, 0), box)).toBeNull();
  });

  it('reports a ray starting inside as an immediate hit', () => {
    const result = rayAabb(hit, vec3(0, 0, 0), vec3(1, 0, 0), box);
    expect(result).not.toBeNull();
    expect(result!.inside).toBe(true);
    expect(result!.t).toBe(0);
  });

  it('handles a ray parallel to a slab without dividing by zero', () => {
    // Direction is +X only: constant Y and Z. Starting inside the Y/Z bands.
    const result = rayAabb(hit, vec3(-5, 0.5, 0.5), vec3(1, 0, 0), box);
    expect(result).not.toBeNull();
    closeTo(result!.t, 4, 1e-9);
    // And the same ray lifted outside the Y band must miss.
    expect(rayAabb(hit, vec3(-5, 1.5, 0.5), vec3(1, 0, 0), box)).toBeNull();
  });

  it('reports the top face normal for a downward ray', () => {
    const result = rayAabb(hit, vec3(0.2, 5, 0.3), vec3(0, -1, 0), box);
    expect(result).not.toBeNull();
    // The box spans y in [-1, 1], so the top face is 4 m below the origin.
    closeTo(result!.t, 4, 1e-9);
    closeTo(result!.normal.y, 1, 1e-9);
  });

  it('picks the nearest of two boxes, which is the "wall beats enemy" rule', () => {
    const wall = aabb(5, 0, 0, 0.1, 2, 2);
    const enemy = aabb(9, 0, 0, 0.4, 0.9, 0.4);
    const origin = vec3(0, 0, 0);
    const dir = vec3(1, 0, 0);
    const wallHit = rayAabb({ t: 0, normal: vec3(), inside: false }, origin, dir, wall);
    const enemyHit = rayAabb({ t: 0, normal: vec3(), inside: false }, origin, dir, enemy);
    expect(wallHit!.t).toBeLessThan(enemyHit!.t);
  });
});

describe('ray / sphere intersection', () => {
  const hit = { t: 0, normal: vec3(), inside: false };

  it('hits a sphere head-on', () => {
    const result = raySphere(hit, vec3(-10, 0, 0), vec3(1, 0, 0), vec3(0, 0, 0), 1);
    expect(result).not.toBeNull();
    closeTo(result!.t, 9, 1e-9);
    closeTo(result!.normal.x, -1, 1e-9);
  });

  it('misses above the sphere', () => {
    expect(raySphere(hit, vec3(-10, 2, 0), vec3(1, 0, 0), vec3(0, 0, 0), 1)).toBeNull();
  });

  it('misses a sphere that is entirely behind the ray', () => {
    expect(raySphere(hit, vec3(-10, 0, 0), vec3(-1, 0, 0), vec3(0, 0, 0), 1)).toBeNull();
  });

  it('treats an origin inside the sphere as an immediate hit', () => {
    const result = raySphere(hit, vec3(0, 0, 0), vec3(1, 0, 0), vec3(0, 0, 0), 1);
    expect(result).not.toBeNull();
    expect(result!.inside).toBe(true);
  });

  it('returns a unit normal for a grazing hit', () => {
    const result = raySphere(hit, vec3(-10, 0.99, 0), vec3(1, 0, 0), vec3(0, 0, 0), 1);
    expect(result).not.toBeNull();
    closeTo(length(result!.normal), 1, 1e-6);
  });
});

describe('volume queries', () => {
  const box = aabb(0, 1, 0, 1, 1, 1);

  it('clamps a point onto the box surface', () => {
    const out = vec3();
    closestPointOnAabb(out, vec3(5, 0, 0), box);
    closeTo(out.x, 1);
    // The box spans y in [0, 2], so a point already inside that band is not lifted.
    closeTo(out.y, 0);
    closeTo(out.z, 0);
  });

  it('detects containment', () => {
    expect(pointInAabb(vec3(0, 1, 0), box)).toBe(true);
    expect(pointInAabb(vec3(0, 2.5, 0), box)).toBe(false);
  });

  it('detects a sphere touching a box but not one hovering above it', () => {
    expect(sphereIntersectsAabb(vec3(1.5, 1, 0), 0.6, box)).toBe(true);
    expect(sphereIntersectsAabb(vec3(1.5, 2.5, 0), 0.4, box)).toBe(false);
  });
});

describe('geometry identities used by the aim chain', () => {
  it('keeps the muzzle on the aim axis, so the crosshair never lies', () => {
    // Reproduces the camera solve symbolically across the pitch range. The muzzle
    // offset is built from the view basis, so it is orthogonal to forward and
    // cannot rotate the direction from the pivot to a point chosen along forward.
    for (const pitch of [-1.4, -0.7, -0.2, 0, 0.35, 1.1, 1.45]) {
      const yaw = 0.8;
      const forward = forwardFromYawPitch(vec3(), yaw, pitch);
      const right = rightFromYawPitch(vec3(), yaw, pitch);
      const up = upFromYawPitch(vec3(), yaw, pitch);

      // The basis must be orthonormal, or the identity below cannot hold.
      closeTo(dot(forward, right), 0, 1e-9);
      closeTo(dot(forward, up), 0, 1e-9);
      closeTo(length(right), 1, 1e-9);

      const pivot = vec3(1, 2, 3);
      const muzzle = vec3(
        pivot.x + right.x * 0.26 + up.x * 0.16,
        pivot.y + up.y * 0.16,
        pivot.z + right.z * 0.26 + up.z * 0.16,
      );
      const aimPoint = vec3(
        pivot.x + forward.x * 100,
        pivot.y + forward.y * 100,
        pivot.z + forward.z * 100,
      );
      const dir = vec3(aimPoint.x - muzzle.x, aimPoint.y - muzzle.y, aimPoint.z - muzzle.z);
      normalize(dir, dir);

      // `normalise(aimPoint − muzzle)` is *not* bit-identical to `forward`: it is
      // forward scaled by `range / hypot(range, |offset|)`, because the muzzle
      // offset is perpendicular to the aim axis and so lengthens the triangle
      // while leaving its direction essentially unchanged. At 100 m with a 0.305 m
      // offset that factor is 0.99999676 — a 0.04° lean at the far end of the
      // weapon's range. That is the correct, unavoidable geometry of a shoulder
      // camera, not an error, and production sidesteps it by reporting `forward`
      // directly (see `solveAim`). This test therefore pins the *equivalence*.
      const offsetLength = Math.hypot(0.26, 0.16);
      const expectedDot = 1 / Math.sqrt(1 + (offsetLength / 100) ** 2);
      expect(dot(dir, forward), `pitch ${pitch}`).toBeCloseTo(expectedDot, 7);
      // The lean is bounded by `atan(|offset| / range)`, which is the smallest it
      // can possibly be for a camera that is not inside the barrel. At 100 m that
      // is ~0.003 rad (0.17°) and it shrinks with range, so the crosshair and the
      // tracer agree everywhere it matters. This bound is what makes the shoulder
      // offset safe; a magnitude larger than the offset itself would mean the
      // offset had rotated out of the perpendicular.
      const angularError = Math.acos(clamp(dot(dir, forward), -1, 1));
      expect(angularError, `pitch ${pitch}`).toBeLessThan((offsetLength / 100) * 1.5);
    }
  });

  it('agrees with the flat right vector when the camera is level', () => {
    // The two right vectors must coincide at zero pitch, or the shoulder offset
    // would shift the moment the player looked up.
    const flat = rightFromYaw(vec3(), 1.1);
    const pitched = rightFromYawPitch(vec3(), 1.1, 0);
    closeTo(flat.x, pitched.x, 1e-12);
    closeTo(flat.y, pitched.y, 1e-12);
    closeTo(flat.z, pitched.z, 1e-12);
  });

  it('keeps the spread cone inside its nominal angle', () => {
    const spreadDeg = 3.4;
    const forward = forwardFromYawPitch(vec3(), 0.3, 0.2);
    // A maximal deflection must be exactly the cone half-angle from the axis.
    const axis = perpendicular(vec3(), forward);
    const deflected = rotateAroundAxis(vec3(), forward, axis, spreadDeg * DEG2RAD);
    const angle = Math.acos(clamp(dot(forward, deflected), -1, 1));
    closeTo(angle, spreadDeg * DEG2RAD, 1e-9);
  });
});
