/**
 * The run's script.
 *
 * Phase 3 pinned its difficulty *curve* here (monotone counts, decaying intervals and
 * boss timers, jitter bands, seed reproducibility). The script has no curve left to pin,
 * so these assertions are the two things that can still be wrong and that no play session
 * would catch cleanly:
 *
 *   1. **Does the script say what was asked for?** 30 small enemies, five drops of
 *      5/5/5/5/10, ten seconds apart, and a ten-second opening. Those are the requirement,
 *      written as numbers, so a later "let me just bump the last drop" is a red test rather
 *      than a silent change to the run.
 *   2. **Is the schedule exactly what the director measures against?** Absolute drop times
 *      spaced by `batchInterval`, with the last one reachable — a schedule that drifted or
 *      floored wrongly would show up as "the drops feel uneven" and nothing else.
 */

import { describe, expect, it } from 'vitest';
import { DIRECTOR, DIRECTOR_TUNING } from '#/core/config';
import { planDeployment, totalSmallEnemies } from '#/game/director/deployment';

describe('the script is the one that was asked for', () => {
  it('releases thirty small enemies in 5/5/5/5/10', () => {
    const script = planDeployment();
    expect(script.drops.map((drop) => drop.count)).toEqual([5, 5, 5, 5, 10]);
    expect(script.totalSmall).toBe(30);
    expect(script.totalDrops).toBe(5);
    // And the table itself, so a change to one is a change to both or neither.
    expect(DIRECTOR.batchSizes).toEqual([5, 5, 5, 5, 10]);
    expect(totalSmallEnemies()).toBe(30);
  });

  it('opens with a ten-second countdown before the first drop', () => {
    const script = planDeployment();
    expect(script.firstDropAt).toBe(10);
    expect(DIRECTOR.openingCountdown).toBe(10);
    expect(script.drops[0]?.at).toBe(10);
  });

  it('drops ten seconds apart, measured from the start of the run', () => {
    const script = planDeployment();
    expect(DIRECTOR.batchInterval).toBe(10);
    expect(script.drops.map((drop) => drop.at)).toEqual([10, 20, 30, 40, 50]);
    for (let i = 1; i < script.drops.length; i += 1) {
      const previous = script.drops[i - 1];
      const current = script.drops[i];
      expect(current && previous ? current.at - previous.at : NaN).toBeCloseTo(script.interval, 10);
    }
  });

  it('says one drop every interval and nothing after the last one', () => {
    // The rule the director's `while` loop depends on: the times are strictly increasing,
    // so exactly one boundary can be crossed per tick and the loop can never release the
    // same drop twice.
    const script = planDeployment();
    const times = script.drops.map((drop) => drop.at);
    expect(new Set(times).size).toBe(times.length);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

describe('the sum is the single source for the run total', () => {
  it('is the drops added up, not a second number', () => {
    const script = planDeployment();
    const sum = script.drops.reduce((total, drop) => total + drop.count, 0);
    expect(script.totalSmall).toBe(sum);
    // `totalSmallEnemies()` is the same computation — it is defined as the resolver's own
    // total, and this pins that it did not quietly become an independent tally.
    expect(totalSmallEnemies()).toBe(sum);
  });

  it('follows a shortened script, which is how a test or a designer retunes the run', () => {
    const saved = DIRECTOR_TUNING.batchSizes;
    const savedInterval = DIRECTOR_TUNING.batchInterval;
    try {
      DIRECTOR_TUNING.batchSizes = [2, 3];
      DIRECTOR_TUNING.batchInterval = 4;
      const script = planDeployment();
      expect(script.totalDrops).toBe(2);
      expect(script.totalSmall).toBe(5);
      expect(totalSmallEnemies()).toBe(5);
      expect(script.drops.map((drop) => drop.at)).toEqual([10, 14]);
    } finally {
      DIRECTOR_TUNING.batchSizes = saved;
      DIRECTOR_TUNING.batchInterval = savedInterval;
    }
  });
});

describe('the resolver never produces a schedule the director cannot run', () => {
  it('floors fractional and negative counts at zero rather than at a fraction', () => {
    const saved = DIRECTOR_TUNING.batchSizes;
    try {
      DIRECTOR_TUNING.batchSizes = [2.7, -3, 0, Number.NaN];
      const script = planDeployment();
      expect(script.drops.map((drop) => drop.count)).toEqual([2, 0, 0, 0]);
      expect(script.totalSmall).toBe(2);
      for (const count of script.drops.map((drop) => drop.count)) {
        expect(Number.isInteger(count)).toBe(true);
        expect(count).toBeGreaterThanOrEqual(0);
      }
    } finally {
      DIRECTOR_TUNING.batchSizes = saved;
    }
  });

  it('keeps a zero-interval script finite and ordered', () => {
    const savedInterval = DIRECTOR_TUNING.batchInterval;
    const savedOpening = DIRECTOR_TUNING.openingCountdown;
    try {
      DIRECTOR_TUNING.batchInterval = 0;
      DIRECTOR_TUNING.openingCountdown = 0;
      const script = planDeployment();
      // Every drop at t = 0: degenerate, but *finite* and in order, so the director
      // releases them all on the first tick instead of waiting for ever.
      for (const drop of script.drops) {
        expect(Number.isFinite(drop.at)).toBe(true);
        expect(drop.at).toBe(0);
      }
      expect(script.totalSmall).toBeGreaterThan(0);
    } finally {
      DIRECTOR_TUNING.batchInterval = savedInterval;
      DIRECTOR_TUNING.openingCountdown = savedOpening;
    }
  });

  it('gives the same script on every call, with no random stream involved', () => {
    // The old curve took an `Rng`. Nothing here does: two runs share the schedule and
    // differ only in where the bodies appear.
    expect(planDeployment()).toEqual(planDeployment());
  });

  it('handles an empty script without inventing a drop', () => {
    const saved = DIRECTOR_TUNING.batchSizes;
    try {
      DIRECTOR_TUNING.batchSizes = [];
      const script = planDeployment();
      expect(script.totalDrops).toBe(0);
      expect(script.totalSmall).toBe(0);
      expect(totalSmallEnemies()).toBe(0);
    } finally {
      DIRECTOR_TUNING.batchSizes = saved;
    }
  });
});
