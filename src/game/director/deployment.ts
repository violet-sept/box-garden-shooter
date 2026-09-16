/**
 * The run's script, resolved to concrete numbers.
 *
 * Pure functions over `DIRECTOR`: no state, no world, no RNG. This replaces the phase-3
 * wave curve (`waves.ts`), and it is *simpler* than what it replaces for the reason the
 * phase-10 request gives: the schedule is fixed, so every number a test wants to assert
 * is an input rather than the output of a curve. `planWave` had to be pinned for
 * monotonicity, floors, jitter bands and seed reproducibility because the difficulty ramp
 * lived in those curves; here there is nothing to ramp and nothing to randomise, so the
 * interesting assertions become "does the script say what the brief says" and "does the
 * director honour it, frame for frame".
 *
 * The one thing that is still a *rule* rather than a number is the sum: **the run's small
 * enemy total is `drops[].count` added up**, and that sum is read by the director (how
 * many it may have in flight), by the world (the release-queue ceiling) and by the tests.
 * One computation, three readers.
 *
 * Hard rules observed here:
 *   - every number comes from `core/config` (rule 4);
 *   - nothing from `three` is imported, not even for a vector (rule 1);
 *   - nothing is drawn from an RNG, so two runs share one schedule.
 */

import { DIRECTOR } from '../../core/config';

/** One drop of small enemies. */
export interface Drop {
  /** 0-based position in the script. */
  readonly index: number;
  /** How many small enemies this drop releases. */
  readonly count: number;
  /** Simulated seconds from the run's first tick at which the drop is released. */
  readonly at: number;
}

/** The whole script, resolved. */
export interface Deployment {
  readonly drops: readonly Drop[];
  /** How many drops the run has. */
  readonly totalDrops: number;
  /** Small enemies in the run: the sum of `drops[].count`. */
  readonly totalSmall: number;
  /** Seconds from the run's start to the first drop — the opening countdown. */
  readonly firstDropAt: number;
  /** Seconds between drops. */
  readonly interval: number;
}

/**
 * A batch size the director can actually act on: a whole, non-negative count.
 *
 * `Math.max(0, Math.floor(x))` is not enough on its own — `Math.max(0, NaN)` is `NaN`, and a
 * `NaN` count would make the director's release loop compare against a `NaN` time for ever.
 * A non-finite size is a broken script, and the honest reading of it is "no enemies in this
 * drop" rather than a schedule that never resolves.
 */
function dropCount(size: number | undefined): number {
  const whole = Math.floor(size ?? 0);
  return Number.isFinite(whole) ? Math.max(0, whole) : 0;
}

/**
 * Resolves the script.
 *
 * A function rather than a module-level constant, for the same reason `totalWaves()` used
 * to be one: `DIRECTOR_TUNING` exists so a test can shorten the run, and a value frozen at
 * import time would ignore every one of those overrides. The director calls this once per
 * run (at construction and again on `reset`), never per tick.
 *
 * `at` is measured from the **run's start** rather than from the previous drop. Absolute
 * times are what make the schedule drift-free: a long frame or a hitstop can delay when a
 * drop is *noticed*, but not which second it belongs to.
 */
export function planDeployment(): Deployment {
  const interval = Math.max(0, DIRECTOR.batchInterval);
  const firstDropAt = Math.max(0, DIRECTOR.openingCountdown);
  const drops: Drop[] = [];
  let totalSmall = 0;
  for (let index = 0; index < DIRECTOR.batchSizes.length; index += 1) {
    const count = dropCount(DIRECTOR.batchSizes[index]);
    drops.push({ index, count, at: firstDropAt + interval * index });
    totalSmall += count;
  }
  return { drops, totalDrops: drops.length, totalSmall, firstDropAt, interval };
}

/**
 * Small enemies in one run.
 *
 * The single source for "how many Stalkers a run contains": it is the script's sum and
 * nothing else — literally `planDeployment().totalSmall`, so the *only* code that adds the
 * batch sizes up is the resolver above. `World` reads it once at construction as the
 * release-queue ceiling, which makes "the director cannot ask for more bodies than the
 * script contains" a checked bound rather than a comment.
 */
export function totalSmallEnemies(): number {
  return planDeployment().totalSmall;
}
