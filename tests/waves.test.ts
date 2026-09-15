/**
 * The wave curve.
 *
 * `docs/阶段3.md` section 7 fixes the assertions: the count is monotone and capped,
 * the interval falls to a floor and never through it, the boss timer does the same,
 * the health scale is the configured power, and one seed always produces one curve.
 *
 * These are numbers a play session would otherwise be the only witness to, and the
 * difficulty curve is the thing most likely to be retuned  - so it is the thing most
 * worth pinning.
 */

import { describe, expect, it } from 'vitest';
import { DIRECTOR, DIRECTOR_TUNING } from '#/core/config';
import { createRng, type Rng } from '#/core/math/rng';
import { isFinalWave, isBreathingWave, intermissionFor, planWave, totalWaves, type WavePlan } from '#/game/director/waves';

/** The plain base curve, before the breathing scale and before any jitter. */
function baseCount(wave: number): number {
  return Math.min(DIRECTOR.smallCountMax, DIRECTOR.smallCountBase + DIRECTOR.smallCountGrowth * wave);
}

/**
 * Plans for every wave with the count jitter pinned off.
 *
 * The jitter is ±12% by design, which is wide enough for a breathing wave (45% of
 * base) to land above a jittered ordinary one  - so monotonicity is only a property
 * of the underlying curve. Pinning the knob is what makes it assertable.
 */
function planAll(seed: number): WavePlan[] {
  const saved = DIRECTOR_TUNING.smallCountJitter;
  DIRECTOR_TUNING.smallCountJitter = 0;
  try {
    const stream: Rng = createRng(seed);
    return Array.from({ length: totalWaves() }, (_, wave) => planWave(wave, stream));
  } finally {
    DIRECTOR_TUNING.smallCountJitter = saved;
  }
}

describe('planWave: the curve', () => {
  it('makes every ordinary wave heavier than the last, and never exceeds the cap', () => {
    const plans = planAll(3);
    let previous = 0;
    for (const plan of plans) {
      expect(plan.smallCount).toBeLessThanOrEqual(DIRECTOR.smallCountMax);
      if (!plan.breathing) {
        expect(plan.smallCount).toBeGreaterThanOrEqual(previous);
        previous = plan.smallCount;
      }
    }
    // A curve that never climbs is not a curve: the last ordinary wave has to be
    // meaningfully heavier than the first, or the run has no pressure ramp.
    const ordinary = plans.filter((plan) => !plan.breathing);
    expect(ordinary.at(-1)?.smallCount ?? 0).toBeGreaterThan(ordinary[0]?.smallCount ?? 0);
  });

  it('makes a breathing wave lighter than the wave before it', () => {
    const plans = planAll(3);
    const breathing = plans.filter((plan) => plan.breathing);
    expect(breathing.length).toBeGreaterThan(0);
    for (let wave = 1; wave < plans.length; wave += 1) {
      if (!isBreathingWave(wave)) continue;
      expect(plans[wave]?.breathing).toBe(true);
      expect(plans[wave]?.smallCount ?? 0).toBeLessThan(plans[wave - 1]?.smallCount ?? 0);
    }
  });

  it('never has a breathing wave first', () => {
    // The opening wave teaches the loop; a lull there teaches nothing.
    expect(isBreathingWave(0)).toBe(false);
    expect(planAll(3)[0]?.breathing).toBe(false);
  });

  it('spawns at least one enemy on every wave, jitter included', () => {
    for (const seed of [1, 2, 3, 11, 4242]) {
      const stream = createRng(seed);
      for (let wave = 0; wave < totalWaves(); wave += 1) {
        expect(planWave(wave, stream).smallCount).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('keeps the jittered count inside its band on every wave', () => {
    const stream = createRng(17);
    for (let wave = 0; wave < totalWaves(); wave += 1) {
      const plan = planWave(wave, stream);
      const scaled = plan.breathing ? baseCount(wave) * DIRECTOR.breathingWaveCountScale : baseCount(wave);
      const lower = scaled * (1 - DIRECTOR.smallCountJitter);
      const upper = scaled * (1 + DIRECTOR.smallCountJitter);
      // One whole enemy of slack on each side: the result is rounded to a count.
      expect(plan.smallCount).toBeGreaterThanOrEqual(Math.floor(lower));
      expect(plan.smallCount).toBeLessThanOrEqual(Math.ceil(upper));
    }
  });

  it('shortens the release interval and floors it', () => {
    const plans = planAll(3);
    for (let wave = 1; wave < plans.length; wave += 1) {
      expect(plans[wave]?.interval ?? 0).toBeLessThanOrEqual(plans[wave - 1]?.interval ?? 0);
    }
    for (const plan of plans) expect(plan.interval).toBeGreaterThanOrEqual(DIRECTOR.spawnIntervalMin);
    // The floor has to be reachable, or it is decoration: a deep enough wave bottoms
    // the decay out.
    expect(planWave(200, createRng(3)).interval).toBeCloseTo(DIRECTOR.spawnIntervalMin, 6);
  });

  it('shortens the boss timer and floors it', () => {
    const plans = planAll(3);
    for (let wave = 1; wave < plans.length; wave += 1) {
      expect(plans[wave]?.bossTimer ?? 0).toBeLessThanOrEqual(plans[wave - 1]?.bossTimer ?? 0);
    }
    for (const plan of plans) {
      expect(plan.bossTimer).toBeGreaterThanOrEqual(DIRECTOR.bossTimerMin);
      expect(plan.bossTimer).toBeLessThanOrEqual(DIRECTOR.bossTimerBase);
    }
    expect(planWave(200, createRng(3)).bossTimer).toBeCloseTo(DIRECTOR.bossTimerMin, 6);
  });

  it('scales health as the configured power of the wave, always upward', () => {
    const plans = planAll(3);
    for (const plan of plans) {
      expect(plan.healthScale).toBeCloseTo(DIRECTOR.smallHealthScalePerWave ** plan.wave, 10);
    }
    for (let wave = 1; wave < plans.length; wave += 1) {
      expect(plans[wave]?.healthScale ?? 0).toBeGreaterThan(plans[wave - 1]?.healthScale ?? 0);
    }
  });

  it('flags the final wave and nothing past it', () => {
    expect(totalWaves()).toBeGreaterThan(1);
    expect(isFinalWave(totalWaves() - 1)).toBe(true);
    expect(isFinalWave(totalWaves() - 2)).toBe(false);
    expect(planAll(3).at(-1)?.final).toBe(true);
  });

  it('extends the pause after a breathing wave', () => {
    const plans = planAll(3);
    const breathing = plans.find((plan) => plan.breathing);
    const ordinary = plans.find((plan) => !plan.breathing);
    expect(breathing).toBeDefined();
    expect(ordinary).toBeDefined();
    if (!breathing || !ordinary) return;
    expect(intermissionFor(breathing)).toBeGreaterThan(intermissionFor(ordinary));
  });

  it('keeps a negative or fractional wave index from producing nonsense', () => {
    for (const index of [-5, -0.5, 0, 0.9]) {
      const plan = planWave(index, createRng(5));
      expect(plan.wave).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(plan.wave)).toBe(true);
      expect(Number.isFinite(plan.smallCount)).toBe(true);
      expect(plan.smallCount).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('planWave: reproducibility', () => {
  it('gives the same curve twice from the same seed', () => {
    const first = Array.from({ length: totalWaves() }, (_, wave) => planWave(wave, createRng(4242)));
    const second = Array.from({ length: totalWaves() }, (_, wave) => planWave(wave, createRng(4242)));
    expect(second).toEqual(first);
  });

  it('gives a different curve from a different seed', () => {
    // The jitter must actually be doing something, or the parameter is a lie.
    const a = Array.from({ length: totalWaves() }, (_, wave) => planWave(wave, createRng(1)));
    const b = Array.from({ length: totalWaves() }, (_, wave) => planWave(wave, createRng(2)));
    expect(a.map((plan) => plan.smallCount)).not.toEqual(b.map((plan) => plan.smallCount));
  });

  it('resolves a wave from its index and its draws alone', () => {
    // Interleaving the calls on one stream changes which jitter draw a wave gets, so
    // the *count* legitimately differs  - but never the parts of the plan that are a
    // pure function of the index. Those are what the director and the HUD rely on.
    const forward = planAll(5);
    const backward = [...planAll(5)].reverse();
    for (const plan of [...forward, ...backward]) {
      expect(plan.interval).toBeCloseTo(
        Math.max(DIRECTOR.spawnIntervalMin, DIRECTOR.spawnInterval * DIRECTOR.spawnIntervalDecay ** plan.wave),
        10,
      );
      expect(plan.bossTimer).toBeCloseTo(
        Math.max(DIRECTOR.bossTimerMin, DIRECTOR.bossTimerBase * DIRECTOR.bossTimerDecay ** plan.wave),
        10,
      );
      expect(plan.breathing).toBe(isBreathingWave(plan.wave));
      expect(plan.final).toBe(isFinalWave(plan.wave));
    }
  });
});
