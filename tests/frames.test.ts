/**
 * Attack frame tests.
 *
 * These exist to pin one thing that is otherwise invisible: **which side of a
 * window boundary the exact instant falls on**. At 60 Hz a one-tick disagreement
 * between "the telegraph ended" and "the strike is live" is enough to make a test
 * flaky and to make a telegraph look one frame shorter than the number in config.
 *
 * The second half of the file is the fairness rule from the brief's hard rule 9:
 * enrage compresses recovery and cooldown, and never the telegraph.
 */

import { describe, expect, it } from 'vitest';
import { ENEMY_LARGE, ENEMY_SMALL, ENRAGE_COOLDOWN_SCALE } from '#/core/config';
import {
  IMPACT_WARNING_WINDOW,
  isActive,
  phaseAt,
  scaledRecoveryTime,
  scaledTotalFrameTime,
  telegraphProgress,
  telegraphRemaining,
  totalFrameTime,
  type AttackFrame,
} from '#/game/enemies/frames';

const FRAME: AttackFrame = { telegraphTime: 0.42, activeTime: 0.12, recoveryTime: 0.55 };

describe('frame phase boundaries', () => {
  it('is in TELEGRAPH strictly before telegraphTime', () => {
    expect(phaseAt(0, FRAME)).toBe('TELEGRAPH');
    expect(phaseAt(FRAME.telegraphTime / 2, FRAME)).toBe('TELEGRAPH');
    expect(phaseAt(FRAME.telegraphTime - 1e-9, FRAME)).toBe('TELEGRAPH');
  });

  it('lands in ACTIVE exactly at telegraphTime, not TELEGRAPH', () => {
    // THE convention, written as an assertion so it cannot drift: each window is
    // left-closed, so the instant a window ends belongs to the next one.
    expect(phaseAt(FRAME.telegraphTime, FRAME)).toBe('ACTIVE');
  });

  it('lands in RECOVER exactly at telegraphTime + activeTime', () => {
    expect(phaseAt(FRAME.telegraphTime + FRAME.activeTime, FRAME)).toBe('RECOVER');
    expect(phaseAt(FRAME.telegraphTime + FRAME.activeTime - 1e-9, FRAME)).toBe('ACTIVE');
  });

  it('is DONE exactly at the total, and stays DONE', () => {
    const total = totalFrameTime(FRAME);
    expect(phaseAt(total, FRAME)).toBe('DONE');
    expect(phaseAt(total + 5, FRAME)).toBe('DONE');
    expect(phaseAt(total - 1e-9, FRAME)).toBe('RECOVER');
  });

  it('advances monotonically through exactly one phase per window', () => {
    const seen: string[] = [];
    const dt = 1 / 60;
    for (let t = 0; t < totalFrameTime(FRAME) + 0.2; t += dt) {
      const phase = phaseAt(t, FRAME);
      if (seen[seen.length - 1] !== phase) seen.push(phase);
    }
    expect(seen).toEqual(['TELEGRAPH', 'ACTIVE', 'RECOVER', 'DONE']);
  });

  it('drives isActive from the same clock as phaseAt', () => {
    expect(isActive(FRAME.telegraphTime - 1e-9, FRAME)).toBe(false);
    expect(isActive(FRAME.telegraphTime, FRAME)).toBe(true);
    expect(isActive(FRAME.telegraphTime + FRAME.activeTime, FRAME)).toBe(false);
  });

  it('tolerates a degenerate frame without producing NaN', () => {
    const empty: AttackFrame = { telegraphTime: 0, activeTime: 0, recoveryTime: 0 };
    expect(phaseAt(0, empty)).toBe('DONE');
    expect(Number.isNaN(phaseAt(0, empty) as unknown as number)).toBe(false);
    expect(scaledTotalFrameTime(empty, 0.75)).toBe(0);
  });

  it('keeps negative times in the first window rather than wrapping', () => {
    // A negative elapsed cannot happen from the FSM, but a caller that subtracts a
    // hitstop could produce one, and "negative time is the end of the attack" would
    // be a spectacularly confusing failure.
    expect(phaseAt(-1, FRAME)).toBe('TELEGRAPH');
  });
});

describe('telegraph readouts', () => {
  it('counts the telegraph down to zero and no further', () => {
    expect(telegraphRemaining(0, FRAME)).toBeCloseTo(FRAME.telegraphTime, 12);
    expect(telegraphRemaining(FRAME.telegraphTime / 2, FRAME)).toBeCloseTo(FRAME.telegraphTime / 2, 12);
    expect(telegraphRemaining(FRAME.telegraphTime, FRAME)).toBe(0);
    expect(telegraphRemaining(99, FRAME)).toBe(0);
  });

  it('ramps progress from 0 to 1 and saturates', () => {
    expect(telegraphProgress(0, FRAME)).toBe(0);
    expect(telegraphProgress(FRAME.telegraphTime / 2, FRAME)).toBeCloseTo(0.5, 12);
    expect(telegraphProgress(FRAME.telegraphTime, FRAME)).toBe(1);
    expect(telegraphProgress(99, FRAME)).toBe(1);
  });

  it('treats a zero-length telegraph as already complete', () => {
    const instant: AttackFrame = { telegraphTime: 0, activeTime: 0.1, recoveryTime: 0.1 };
    expect(telegraphProgress(0, instant)).toBe(1);
    expect(phaseAt(0, instant)).toBe('ACTIVE');
  });

  it('keeps the impact warning window inside a barrage telegraph', () => {
    // The ground indicators light up IMPACT_WARNING_WINDOW before the blast. If the
    // window ever exceeded the telegraph the markers would be up before the wind-up
    // started, which is the same as having no warning at all.
    expect(IMPACT_WARNING_WINDOW).toBeLessThan(ENEMY_LARGE.telegraphTime);
    expect(IMPACT_WARNING_WINDOW).toBeGreaterThan(0);
  });
});

describe('enrage scaling', () => {
  it('compresses the recovery window by the configured scale', () => {
    expect(scaledRecoveryTime(FRAME, ENRAGE_COOLDOWN_SCALE)).toBeCloseTo(
      FRAME.recoveryTime * ENRAGE_COOLDOWN_SCALE,
      12,
    );
    expect(scaledRecoveryTime(FRAME, 1)).toBe(FRAME.recoveryTime);
  });

  it('leaves telegraphTime bit-for-bit unchanged', () => {
    // Hard rule 9. Asserted against the exact value rather than a tolerance,
    // because the whole point is that nothing touches it.
    const scaled = scaledTotalFrameTime(FRAME, ENRAGE_COOLDOWN_SCALE);
    const expected = FRAME.telegraphTime + FRAME.activeTime + FRAME.recoveryTime * ENRAGE_COOLDOWN_SCALE;
    expect(scaled).toBe(expected);
    // And the boundary at which the strike lands is therefore identical.
    expect(phaseAt(FRAME.telegraphTime, FRAME, ENRAGE_COOLDOWN_SCALE)).toBe('ACTIVE');
    expect(phaseAt(FRAME.telegraphTime - 1e-9, FRAME, ENRAGE_COOLDOWN_SCALE)).toBe('TELEGRAPH');
  });

  it('shortens the total by exactly the recovery it removed', () => {
    const normal = totalFrameTime(FRAME);
    const enraged = scaledTotalFrameTime(FRAME, ENRAGE_COOLDOWN_SCALE);
    const removed = FRAME.recoveryTime * (1 - ENRAGE_COOLDOWN_SCALE);
    expect(normal - enraged).toBeCloseTo(removed, 12);
  });

  it('never lets a hostile scale produce a negative window', () => {
    expect(scaledRecoveryTime(FRAME, -3)).toBe(0);
    expect(scaledTotalFrameTime(FRAME, -3)).toBeGreaterThan(0);
    // And the attack still ends, rather than looping at RECOVER forever.
    expect(phaseAt(FRAME.telegraphTime + FRAME.activeTime, FRAME, -3)).toBe('DONE');
  });

  it('holds for both shipped archetypes', () => {
    for (const stats of [ENEMY_SMALL, ENEMY_LARGE]) {
      const frame: AttackFrame = {
        telegraphTime: stats.telegraphTime,
        activeTime: stats.activeTime,
        recoveryTime: stats.recoveryTime,
      };
      expect(phaseAt(stats.telegraphTime, frame, ENRAGE_COOLDOWN_SCALE)).toBe('ACTIVE');
      // A window shorter than one tick would be unobservable at 60 Hz.
      expect(stats.activeTime).toBeGreaterThan(1 / 60);
      expect(stats.recoveryTime).toBeGreaterThan(1 / 60);
    }
  });
});
