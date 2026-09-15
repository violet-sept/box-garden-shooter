/**
 * Steering tests.
 *
 * Two properties are worth more than all the others here, because both are silent
 * when they break:
 *
 *   1. **No NaN, ever.** A NaN in an enemy's velocity spreads through the position
 *      and then through the separation term into every neighbour, and the visible
 *      symptom is a whole wave vanishing rather than an exception. The degenerate
 *      inputs are therefore all exercised: exactly coincident bodies, zero-length
 *      seeks, zero radii.
 *   2. **The speed cap holds.** Every output is bounded by the `maxSpeed` the caller
 *      passed, so "the enemy outran its configured speed" is checked at the one
 *      place it could happen instead of being argued about from a replay.
 */

import { describe, expect, it } from 'vitest';
import { vec3, length, distanceXZ } from '#/core/math/vec3';
import {
  arrive,
  clampSpeed,
  keepDistance,
  seek,
  separation,
} from '#/game/enemies/steering';

const OUT = vec3();

describe('clampSpeed', () => {
  it('leaves a shorter vector untouched', () => {
    const v = vec3(1, 0, 0);
    clampSpeed(v, 5);
    expect(v.x).toBe(1);
  });

  it('scales a longer vector down to exactly the cap', () => {
    const v = vec3(30, 40, 0);
    clampSpeed(v, 5);
    expect(length(v)).toBeCloseTo(5, 12);
  });

  it('keeps direction when it clamps', () => {
    const v = vec3(3, 0, 4);
    clampSpeed(v, 1);
    expect(v.x).toBeCloseTo(0.6, 12);
    expect(v.z).toBeCloseTo(0.8, 12);
  });

  it('collapses a zero vector to zero rather than to NaN', () => {
    const v = vec3(0, 0, 0);
    clampSpeed(v, 5);
    expect(v.x).toBe(0);
    expect(v.y).toBe(0);
    expect(v.z).toBe(0);
  });
});

describe('seek', () => {
  it('points at the target at full speed', () => {
    seek(OUT, vec3(0, 0, 0), vec3(0, 0, -10), 5);
    expect(OUT.z).toBeCloseTo(-5, 12);
    expect(OUT.x).toBeCloseTo(0, 12);
  });

  it('ignores the vertical axis entirely', () => {
    // A target directly overhead on flat ground: the horizontal component is zero,
    // so the enemy does not climb. This is the "enemies do not fly" rule.
    seek(OUT, vec3(0, 0, 0), vec3(0, 20, 0), 5);
    expect(OUT.x).toBe(0);
    expect(OUT.y).toBe(0);
    expect(OUT.z).toBe(0);
  });

  it('returns zero, not NaN, when it is already there', () => {
    seek(OUT, vec3(4, 0, 4), vec3(4, 0, 4), 5);
    expect(OUT.x).toBe(0);
    expect(Number.isNaN(OUT.x)).toBe(false);
    expect(Number.isNaN(OUT.z)).toBe(false);
  });

  it('never exceeds the requested speed', () => {
    for (const distance of [0.001, 1, 50, 1e6]) {
      seek(OUT, vec3(0, 0, 0), vec3(distance, 0, distance), 5.2);
      expect(length(OUT)).toBeLessThanOrEqual(5.2 + 1e-9);
    }
  });
});

describe('arrive', () => {
  it('slows down inside the slow radius', () => {
    arrive(OUT, vec3(0, 0, 0), vec3(0, 0, -5), 10, 10);
    const inside = length(OUT);
    expect(inside).toBeLessThan(10);
    expect(inside).toBeGreaterThan(0);
  });

  it('runs at full speed outside the slow radius', () => {
    arrive(OUT, vec3(0, 0, 0), vec3(0, 0, -40), 10, 10);
    expect(length(OUT)).toBeCloseTo(10, 12);
  });

  it('reaches a standstill at the target and does not overshoot', () => {
    // Integrated at 60 Hz from 20 m out: the step must never carry the body past
    // the target, because an overshoot means an enemy visibly jitters on arrival.
    const target = vec3(0, 0, 0);
    const self = vec3(20, 0, 0);
    const dt = 1 / 60;
    let previous = distanceXZ(self, target);
    for (let i = 0; i < 600; i += 1) {
      arrive(OUT, self, target, 5.2, 3);
      self.x += OUT.x * dt;
      self.z += OUT.z * dt;
      const now = distanceXZ(self, target);
      // Monotone approach: no step may increase the distance.
      expect(now).toBeLessThanOrEqual(previous + 1e-9);
      previous = now;
    }
    expect(previous).toBeLessThan(0.01);
    // And the velocity has decayed to essentially nothing at the target.
    arrive(OUT, self, target, 5.2, 3);
    expect(length(OUT)).toBeLessThan(0.05);
  });

  it('never exceeds the requested speed', () => {
    for (const slowRadius of [0, 0.001, 5, 100]) {
      arrive(OUT, vec3(0, 0, 0), vec3(0, 0, -30), 5.2, slowRadius);
      expect(length(OUT)).toBeLessThanOrEqual(5.2 + 1e-9);
    }
  });
});

describe('separation', () => {
  it('pushes two overlapping units apart, and the gap grows monotonically', () => {
    const a = vec3(0, 0, 0);
    const b = vec3(0.2, 0, 0);
    let previous = distanceXZ(a, b);
    const dt = 1 / 60;
    for (let i = 0; i < 200; i += 1) {
      separation(OUT, a, [b], 1.2, 4);
      a.x += OUT.x * dt;
      a.z += OUT.z * dt;
      separation(OUT, b, [a], 1.2, 4);
      b.x += OUT.x * dt;
      b.z += OUT.z * dt;
      const now = distanceXZ(a, b);
      expect(now).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = now;
    }
    // They converge on the separation radius from below. The approach is
    // asymptotic rather than crossing, because the force falls linearly to zero at
    // the radius: a hard cutoff would produce a visible jolt the moment a neighbour
    // entered range, so settling onto the boundary is the intended behaviour.
    expect(previous).toBeGreaterThan(1.19);
    expect(previous).toBeLessThanOrEqual(1.2 + 1e-9);
  });

  it('produces no NaN when two units are exactly coincident', () => {
    const a = vec3(3, 0, 3);
    const b = vec3(3, 0, 3);
    separation(OUT, a, [b], 1.2, 4);
    expect(Number.isFinite(OUT.x)).toBe(true);
    expect(Number.isFinite(OUT.z)).toBe(true);
    // And it does not return a zero force, which would leave them stacked for ever.
    expect(Math.abs(OUT.x)).toBeGreaterThan(0);
  });

  it('separates coincident units deterministically, so a seeded run is reproducible', () => {
    const a = vec3(0, 0, 0);
    const b = vec3(0, 0, 0);
    const first = vec3();
    const second = vec3();
    separation(first, a, [b], 1.2, 4);
    separation(second, a, [b], 1.2, 4);
    expect(first.x).toBe(second.x);
    expect(first.z).toBe(second.z);
  });

  it('ignores neighbours outside the radius', () => {
    separation(OUT, vec3(0, 0, 0), [vec3(50, 0, 0)], 1.2, 4);
    expect(OUT.x).toBe(0);
    expect(OUT.z).toBe(0);
  });

  it('ignores itself by reference, so an enemy in its own list is not repelled', () => {
    const self = vec3(0, 0, 0);
    separation(OUT, self, [self], 1.2, 4);
    expect(OUT.x).toBe(0);
    expect(OUT.z).toBe(0);
  });

  it('stays finite with a zero radius instead of dividing by zero', () => {
    separation(OUT, vec3(0, 0, 0), [vec3(0, 0, 0)], 0, 4);
    expect(Number.isFinite(OUT.x)).toBe(true);
    expect(Number.isFinite(OUT.z)).toBe(true);
  });
});

describe('keepDistance', () => {
  it('closes when further away than the band', () => {
    keepDistance(OUT, vec3(0, 0, 0), vec3(0, 0, -40), 18, 26, 1.9);
    expect(OUT.z).toBeLessThan(0);
  });

  it('backs away when closer than the band', () => {
    keepDistance(OUT, vec3(0, 0, 0), vec3(0, 0, -5), 18, 26, 1.9);
    expect(OUT.z).toBeGreaterThan(0);
  });

  it('holds still inside the band', () => {
    keepDistance(OUT, vec3(0, 0, 0), vec3(0, 0, -22), 18, 26, 1.9);
    expect(OUT.x).toBeCloseTo(0, 12);
    expect(OUT.z).toBeCloseTo(0, 12);
  });

  it('adds the lateral strafe without breaking the radial behaviour', () => {
    keepDistance(OUT, vec3(0, 0, 0), vec3(0, 0, -22), 18, 26, 1.9, 0.9);
    // Facing -Z, "right" is -X.
    expect(Math.abs(OUT.x)).toBeCloseTo(0.9, 9);
    expect(OUT.z).toBeCloseTo(0, 9);
  });

  it('never produces NaN for a degenerate band or an exact overlap', () => {
    keepDistance(OUT, vec3(0, 0, 0), vec3(0, 0, 0), 18, 26, 1.9);
    expect(Number.isFinite(OUT.x)).toBe(true);
    expect(Number.isFinite(OUT.z)).toBe(true);
    keepDistance(OUT, vec3(0, 0, 0), vec3(0, 0, -20), 10, 10, 1.9);
    expect(Number.isFinite(OUT.z)).toBe(true);
  });
});

/*
 * `leadTarget` lived here and is gone, deliberately.
 *
 * It predicted where a moving player would be `leadTime` seconds later, and its only caller was
 * the Warden's area barrage: the shells had to land where the player was *going* to be, because
 * they were aimed at the ground the player would run across. The shot that replaced that attack
 * is a straight line from the Warden to the player's current position, so a lead prediction has
 * no caller and no meaning — and a helper that only its own test exercises is exactly the "dead
 * knob" this project removes rather than keeps warm. The four assertions that used to sit here
 * were assertions about a behaviour, and the behaviour is gone.
 */
