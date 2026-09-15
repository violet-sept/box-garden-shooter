/**
 * The wave curve.
 *
 * Pure functions over the wave index: no state, no world, no side effects. This is
 * the one part of the director that gets retuned constantly, so it is the one part
 * that has to be assertable as data — "the third wave is harder than the second"
 * should be a test, not a play session.
 *
 * `rng` exists so two runs are not the same script, and it is drawn from in a fixed
 * order so that a seed still reproduces a run exactly. Every field the curve derives
 * is either monotone by construction or explicitly jittered, which is what lets the
 * randomisation be present without making the difficulty unmeasurable.
 *
 * Hard rules observed here:
 *   - every number comes from `core/config` (rule 4);
 *   - the RNG is injected, never global (rule 7);
 *   - nothing from `three` is imported, not even for a vector (rule 1).
 */

import { DIRECTOR } from '../../core/config';
import type { Rng } from '../../core/math/rng';

/** Everything one wave needs, resolved to concrete numbers. */
export interface WavePlan {
  /** 0-based wave index. The HUD shows `wave + 1`. */
  readonly wave: number;
  /** How many small enemies this wave releases in total. */
  readonly smallCount: number;
  /** Seconds between individual releases at the start of the wave. */
  readonly interval: number;
  /** Seconds the small enemies get before the large one is forced out. */
  readonly bossTimer: number;
  /** Health multiplier applied to every small enemy this wave. */
  readonly healthScale: number;
  /** True for a breathing wave: fewer enemies, a longer pause after it. */
  readonly breathing: boolean;
  /** True for the last wave of the run. */
  readonly final: boolean;
}

/**
 * Total waves in a run.
 *
 * A getter rather than a copied constant: reading `DIRECTOR.totalWaves` once at
 * module load would freeze it, and a test that shortens a run (to reach the victory
 * branch without simulating eight waves) would silently keep getting the shipped
 * value. The table is the single source; this only names it.
 */
export function totalWaves(): number {
  return DIRECTOR.totalWaves;
}

/**
 * True when the wave index is a breathing wave.
 *
 * 0-based indices, and the cadence is `breathingWaveEvery`: with the default of 3,
 * waves 3, 6, 9 … (indices 2, 5, 8) breathe. Index 0 deliberately does not — the
 * opening wave is the one that teaches the loop, and it should not be a lull.
 */
export function isBreathingWave(wave: number): boolean {
  if (DIRECTOR.breathingWaveEvery < 2) return false;
  if (wave <= 0) return false;
  return (wave + 1) % DIRECTOR.breathingWaveEvery === 0;
}

/** True for the last wave of the configured run. */
export function isFinalWave(wave: number): boolean {
  const total = DIRECTOR.totalWaves;
  return total > 0 && wave >= total - 1;
}

/** Rounds to a whole enemy, never below one. A wave that spawns nothing is a bug. */
function roundCount(value: number): number {
  return Math.max(1, Math.round(value));
}

/**
 * Resolves one wave.
 *
 * The three curves are independent on purpose:
 *   - `smallCount` climbs linearly and is capped, so late waves are pressure
 *     rather than a wall;
 *   - `interval` decays geometrically to a floor, so the *rate* of arrivals keeps
 *     rising after the cap has flattened the count;
 *   - `bossTimer` decays geometrically to a floor, so a skilled player's reward for
 *     clearing early stays meaningful while a struggling player still gets the boss
 *     inside the run's running time.
 */
export function planWave(wave: number, rng: Rng): WavePlan {
  const index = Math.max(0, Math.floor(wave));
  const breathing = isBreathingWave(index);

  const base = Math.min(DIRECTOR.smallCountMax, DIRECTOR.smallCountBase + DIRECTOR.smallCountGrowth * index);
  // Jitter is drawn *before* the breathing scaling so the two are independent and a
  // test can pin the curve by setting the jitter to zero.
  const jitter = DIRECTOR.smallCountJitter > 0 ? 1 + rng.range(-DIRECTOR.smallCountJitter, DIRECTOR.smallCountJitter) : 1;
  const scaled = breathing ? base * DIRECTOR.breathingWaveCountScale : base;
  const smallCount = roundCount(Math.min(DIRECTOR.smallCountMax, scaled * jitter));

  const interval = Math.max(
    DIRECTOR.spawnIntervalMin,
    DIRECTOR.spawnInterval * DIRECTOR.spawnIntervalDecay ** index,
  );
  const bossTimer = Math.max(
    DIRECTOR.bossTimerMin,
    DIRECTOR.bossTimerBase * DIRECTOR.bossTimerDecay ** index,
  );

  return {
    wave: index,
    smallCount,
    interval,
    bossTimer,
    healthScale: DIRECTOR.smallHealthScalePerWave ** index,
    breathing,
    final: isFinalWave(index),
  };
}

/** Seconds of quiet before the next wave starts, which a breathing wave extends. */
export function intermissionFor(plan: WavePlan): number {
  return DIRECTOR.interWaveDelay + (plan.breathing ? DIRECTOR.breathingWaveExtraDelay : 0);
}

/** Charges granted for clearing this wave. */
export function rewardFor(plan: WavePlan, chargesPerWave: number, chargesPerBreathingWave: number): number {
  return plan.breathing ? chargesPerBreathingWave : chargesPerWave;
}
