/**
 * The wave director.
 *
 * A state machine that reads "what is true about the world this tick" and produces
 * "what should be spawned". It never touches the enemy store (hard rule 13): the
 * `World` executes the orders. That separation is what lets all three boss-unlock
 * paths — cleared, timeout, and both at once — be tested without building a world
 * at all, which matters because the two-locks-one-boss case is exactly the sort of
 * thing that only fails in a real run.
 *
 * ## The core rule (brief section 1.2)
 *
 * A wave releases its small enemies one at a time, and simultaneously starts two
 * clocks for the large one:
 *
 *   (A) every small enemy is dead          — player-driven, rewards skill
 *   (B) `bossTimer` seconds have elapsed   — a backstop, so a stuck player still
 *                                            reaches the boss
 *
 * Whichever happens first releases the large enemy, and *both* publish the same
 * event with a `reason`. Two event names would mean two subscription sites, and one
 * of them would eventually miss a fix.
 *
 * ## Shape of a wave
 *
 *   SPAWNING_SMALL  release `smallCount` at `interval`
 *   BOSS_LOCKED     all released, smalls still alive, waiting on (A) or (B)
 *   BOSS_ACTIVE     the large enemy is out; smalls trickle in slowly
 *   INTERMISSION    quiet between waves
 *
 * A wave is only "cleared" when its large enemy is dead **and** no small enemies
 * remain, so a victory can never leave stragglers behind for the next wave's
 * bookkeeping to trip over. Breathing waves release no large enemy at all.
 */

import { DIRECTOR, DIRECTOR_REWARDS, type EnemyArchetypeId } from '../../core/config';
import { createRng, type Rng } from '../../core/math/rng';
import { distanceXZ, type Vector3 } from '../../core/math/vec3';
import { pickSpawnPoint } from './spawnPoints';
import { intermissionFor, planWave, type WavePlan } from './waves';

/** What the director is allowed to know about the world this tick. */
export interface DirectorContext {
  readonly tick: number;
  /** Simulated seconds, for the run timer on the results screen. */
  readonly time: number;
  readonly dt: number;
  readonly playerPosition: Vector3;
  readonly playerYaw: number;
  readonly playerDead: boolean;
  /** Live combatants with the practice dummies already excluded (`liveCount()`). */
  readonly smallAlive: number;
  readonly bossAlive: boolean;
}

/** One "spawn here" order. */
export interface SpawnCommand {
  /**
   * Unique per order.
   *
   * The world confirms every order exactly once — with `confirmSpawn` when the body
   * is created, or `abandonSpawn` when the run ended first. Matching on the id rather
   * than on position is what makes the two idempotent and keeps a late confirmation
   * from being credited to a different order.
   */
  readonly orderId: number;
  readonly position: Vector3;
  readonly healthScale: number;
  /** Seconds the ground warning runs before the body appears. */
  readonly warning: number;
  /** True for the large enemy. There is at most one per wave. */
  readonly boss: boolean;
}

/** Which phase the machine is in. Kept as values so tests can read it directly. */
export type DirectorPhase =
  | 'OPENING'
  | 'SPAWNING_SMALL'
  | 'BOSS_LOCKED'
  | 'BOSS_ACTIVE'
  | 'INTERMISSION'
  | 'VICTORY'
  | 'DEFEAT';

/** The run's outcome, or `'running'` while it is still going. */
export type RunOutcome = 'running' | 'victory' | 'defeat';

/** How the large enemy was released, for the one `boss:spawned` event. */
export type BossUnlockReason = 'cleared' | 'timeout';

/** Broadcast facts the world turns into events. */
export interface DirectorEvents {
  waveStarted(plan: WavePlan): void;
  waveCleared(plan: WavePlan, reward: number): void;
  bossSpawned(order: SpawnCommand, reason: BossUnlockReason): void;
  spawnPending(order: SpawnCommand, archetype: EnemyArchetypeId): void;
  runEnded(outcome: 'victory' | 'defeat'): void;
}

/** Read-only snapshot for the HUD and the debug panel. */
export interface DirectorStatus {
  phase: DirectorPhase;
  /** 0-based wave index. */
  waveIndex: number;
  /** 1-based wave number, which is what the player is shown. */
  wave: number;
  totalWaves: number;
  outcome: RunOutcome;
  /** Small enemies still to be released this wave. */
  remaining: number;
  /** Seconds left on the current phase's timer, or 0 when it has none. */
  timer: number;
  /** True while the wave still owes the player a large enemy. */
  bossPending: boolean;
  /**
   * The concurrency bookkeeping, exposed so a test can assert the cap rather than
   * infer it: `smallAlive + inFlightSmall <= maxConcurrentSmall` must hold on every
   * tick, and `spawnedSmall` is how many of this wave's allotment have actually
   * appeared (trickles included).
   */
  spawnedSmall: number;
  inFlightSmall: number;
  plannedSmall: number;
  /** How the large enemy was released, once it has been. Diagnostics, not rules. */
  unlockReason: BossUnlockReason | 'none';
}

/** The director's public surface. */
export interface Director {
  readonly status: DirectorStatus;
  /**
   * Advances one tick and appends this tick's spawn orders to `out`.
   *
   * At most a handful per tick, and never a whole wave: the release cadence is what
   * makes six enemies a fight rather than a jumpscare.
   */
  tick(ctx: DirectorContext, out: SpawnCommand[]): void;
  /** Back to the opening grace period, with a fresh random stream. */
  reset(): void;
  /**
   * Reports that an ordered enemy now exists in the world.
   *
   * Idempotent, and ignored for unknown ids. The in-flight count is what keeps the
   * concurrency cap honest: an order is "in flight" from the moment it is issued
   * until the body appears or is abandoned, so the director cannot pile up more
   * orders than the cap allows while it waits for the warning to elapse.
   */
  confirmSpawn(orderId: number): void;
  /** Reports that an ordered enemy will never appear. Idempotent. */
  abandonSpawn(orderId: number): void;
  /**
   * Whether a queued spawn is still legal.
   *
   * The world re-checks this after the warning delay: by then the player may have
   * died, which must cancel the whole wave rather than deliver one last enemy onto
   * a results screen.
   */
  acceptsPending(): boolean;
}

/** Options for {@link createDirector}. */
export interface DirectorOptions {
  readonly seed: number;
  readonly events: DirectorEvents;
}

export function createDirector({ seed, events }: DirectorOptions): Director {
  let rng: Rng = createRng(seed);

  let phase: DirectorPhase = 'OPENING';
  let outcome: RunOutcome = 'running';
  let waveIndex = 0;
  /**
   * The current wave's plan.
   *
   * Assigned by `enterWave`, never at construction: the plan is built from the RNG,
   * so building one here *and* again when the opening ends would consume the jitter
   * draw twice. That would make a fresh run and a reset run diverge, which is a
   * silent violation of "same seed, same sequence" — and it is exactly the sort of
   * difference that only shows up as "the second run feels different".
   */
  let plan!: WavePlan;
  /** Small enemies still to release this wave. */
  let remaining = 0;
  /** Seconds until the next release, or until the phase transition. */
  let timer: number = DIRECTOR.openingGracePeriod;
  /** Seconds until the next reinforcement trickle while the large enemy is alive. */
  let addTimer: number = DIRECTOR.addsIntervalWhileBossAlive;
  /** True while this wave still owes the player a large enemy. */
  let bossPending = false;
  /** Set the moment the large enemy is released, so it can only happen once. */
  let bossReleased = false;
  /** How the large enemy was released, once it has been. */
  let lastUnlockReason: BossUnlockReason | 'none' = 'none';
  /** Small enemies of this wave whose body has appeared. Diagnostics. */
  let spawnedSmall = 0;
  /** Small enemies the current wave planned to release. */
  let plannedSmall = 0;
  /** Orders issued but not yet reflected in `ctx.smallAlive`. */
  let inFlightSmall = 0;
  /** Ids of the orders counted in {@link inFlightSmall}. */
  const inFlightOrders = new Set<number>();
  let nextOrderId = 1;

  /** Points already chosen this tick, so one burst stays spread out. */
  const chosen: Vector3[] = [];

  const status: DirectorStatus = {
    phase: 'OPENING',
    waveIndex: 0,
    wave: 1,
    totalWaves: DIRECTOR.totalWaves,
    outcome: 'running',
    remaining: 0,
    timer: 0,
    bossPending: false,
    spawnedSmall: 0,
    inFlightSmall: 0,
    plannedSmall: 0,
    unlockReason: 'none',
  };

  const publishStatus = (): void => {
    status.phase = phase;
    status.waveIndex = waveIndex;
    status.wave = waveIndex + 1;
    status.totalWaves = DIRECTOR.totalWaves;
    status.outcome = outcome;
    status.remaining = remaining;
    status.timer = timer;
    status.bossPending = bossPending;
    status.spawnedSmall = spawnedSmall;
    status.inFlightSmall = inFlightSmall;
    status.plannedSmall = plannedSmall;
    status.unlockReason = lastUnlockReason;
  };

  /** Seconds between releases for this wave, floored and never zero. */
  const releaseInterval = (): number => Math.max(DIRECTOR.spawnIntervalMin, plan.interval);

  /**
   * Chooses a spawn point for one order.
   *
   * The tick's already-chosen points are passed in so a burst stays spread out. The
   * large enemy is checked again against the others: two bodies inside each other at
   * the arena edge is the one placement the four spawn rules cannot catch, because
   * each point is individually legal.
   */
  const pickPoint = (ctx: DirectorContext, needsSeparation: boolean): Vector3 => {
    const point: Vector3 = { x: 0, y: 0, z: 0 };
    pickSpawnPoint(point, { playerPosition: ctx.playerPosition, playerYaw: ctx.playerYaw, chosen }, rng);
    if (needsSeparation) {
      const second: Vector3 = { x: 0, y: 0, z: 0 };
      for (let attempt = 0; attempt < 4; attempt += 1) {
        pickSpawnPoint(second, { playerPosition: ctx.playerPosition, playerYaw: ctx.playerYaw, chosen }, rng);
        if (distanceXZ(second, point) >= DIRECTOR.minSpawnSeparation) {
          chosen.push({ x: point.x, y: point.y, z: point.z });
          chosen.push({ x: second.x, y: second.y, z: second.z });
          return second;
        }
      }
    }
    chosen.push({ x: point.x, y: point.y, z: point.z });
    return point;
  };

  const enterWave = (index: number): void => {
    waveIndex = index;
    plan = planWave(index, rng);
    phase = 'SPAWNING_SMALL';
    remaining = plan.smallCount;
    plannedSmall = plan.smallCount;
    spawnedSmall = 0;
    // The first release happens on the *next* tick. The wave's own beat is the
    // banner the player sees, and an enemy appearing on the same tick reads as the
    // banner having caused it.
    timer = 0;
    addTimer = DIRECTOR.addsIntervalWhileBossAlive;
    bossPending = !plan.breathing;
    bossReleased = false;
    lastUnlockReason = 'none';
    events.waveStarted(plan);
  };

  const enterWin = (): void => {
    phase = 'VICTORY';
    outcome = 'victory';
    timer = 0;
    remaining = 0;
    bossPending = false;
    events.runEnded('victory');
  };

  const enterDefeat = (): void => {
    phase = 'DEFEAT';
    outcome = 'defeat';
    timer = 0;
    // Everything already ordered is dropped. Without this the player watches
    // reinforcements walk in over their own results screen.
    remaining = 0;
    bossPending = false;
    bossReleased = false;
    events.runEnded('defeat');
  };

  const clearWave = (): void => {
    const reward = plan.breathing ? DIRECTOR_REWARDS.chargesPerBreathingWave : DIRECTOR_REWARDS.chargesPerWaveCleared;
    events.waveCleared(plan, reward);
    if (plan.final) {
      enterWin();
      return;
    }
    phase = 'INTERMISSION';
    timer = intermissionFor(plan);
  };

  /** Releases the large enemy exactly once. Both unlock paths funnel through here. */
  const releaseBoss = (ctx: DirectorContext, reason: BossUnlockReason, out: SpawnCommand[]): void => {
    if (bossReleased) return;
    bossReleased = true;
    bossPending = false;
    lastUnlockReason = reason;
    phase = 'BOSS_ACTIVE';
    addTimer = DIRECTOR.addsIntervalWhileBossAlive;
    const order: SpawnCommand = {
      orderId: nextOrderId++,
      position: pickPoint(ctx, true),
      healthScale: plan.healthScale,
      warning: DIRECTOR.spawnWarningDuration,
      boss: true,
    };
    out.push(order);
    events.spawnPending(order, 'large');
    events.bossSpawned(order, reason);
  };

  /**
   * How many more small enemies this wave may have on their way.
   *
   * `ctx.smallAlive` only counts bodies that exist. An order that has been issued but
   * whose warning has not elapsed is invisible to it, so without the in-flight term
   * the director would issue a whole wave's worth of orders during the warning
   * window and blow straight through `maxConcurrentSmall` — which is the difference
   * between "bounded pressure" and the thing the cap exists to prevent.
   */
  const smallCapacity = (ctx: DirectorContext): number =>
    DIRECTOR.maxConcurrentSmall - Math.max(0, ctx.smallAlive) - inFlightSmall;

  const smallOrder = (ctx: DirectorContext, out: SpawnCommand[]): void => {
    if (smallCapacity(ctx) <= 0) return;
    const order: SpawnCommand = {
      orderId: nextOrderId++,
      position: pickPoint(ctx, false),
      healthScale: plan.healthScale,
      warning: DIRECTOR.spawnWarningDuration,
      boss: false,
    };
    inFlightSmall += 1;
    inFlightOrders.add(order.orderId);
    out.push(order);
    events.spawnPending(order, 'small');
  };

  return {
    get status() {
      publishStatus();
      return status;
    },

    tick(ctx, out) {
      out.length = 0;
      chosen.length = 0;

      // Death ends the run from anywhere, including part-way through a wave. The
      // phase guard is what the trap table asks for: `playerDead` *and* the phase,
      // never either alone.
      if (ctx.playerDead) {
        if (phase !== 'DEFEAT' && phase !== 'VICTORY') enterDefeat();
        publishStatus();
        return;
      }

      switch (phase) {
        case 'OPENING': {
          timer = Math.max(0, timer - ctx.dt);
          if (timer === 0) enterWave(0);
          break;
        }

        case 'SPAWNING_SMALL': {
          if (remaining > 0) {
            timer -= ctx.dt;
            if (timer <= 0) {
              // Accumulate rather than assign, so a long frame does not silently
              // stretch the wave's duration (hard rule 5).
              timer += releaseInterval();
              remaining -= 1;
              smallOrder(ctx, out);
            }
            break;
          }
          // Everything is out. Either the wave is already clear, or the lock starts.
          //
          // `inFlightSmall` is part of the test, not an optimisation: the order for the
          // final Stalker is issued on this very tick and the body does not exist yet,
          // so a bare `smallAlive <= 0` would declare the wave cleared and release the
          // Warden in the same breath as the enemy it is supposed to outlast. This is
          // the same "two criteria that look equivalent" trap the phase-2 bugs came
          // from.
          //
          // `spawnedSmall` is the second half of that test. It matters when the player
          // kills each Stalker on the tick it appears — the field reads empty for the
          // whole release window, and without this the wave would sit in SPAWNING_SMALL
          // for ever waiting for an enemy it had already released and lost.
          if (ctx.smallAlive <= 0 && inFlightSmall <= 0 && spawnedSmall >= plannedSmall) {
            if (bossPending) releaseBoss(ctx, 'cleared', out);
            else clearWave();
            break;
          }
          phase = 'BOSS_LOCKED';
          timer = plan.bossTimer;
          break;
        }

        case 'BOSS_LOCKED': {
          if (bossReleased) {
            // Waiting for the wave's last small enemies after the large one already
            // went down. Only when they are gone is the wave over.
            if (ctx.smallAlive <= 0) clearWave();
            break;
          }
          // (A) cleared: nothing alive, nothing released but unreported, and nothing
          // left to release. The three together are "the wave is over", which is a
          // stronger statement than `smallAlive <= 0` and the one that stays true even
          // when the player kills each enemy on the tick it appears.
          if (ctx.smallAlive <= 0 && inFlightSmall <= 0 && remaining <= 0 && spawnedSmall >= plannedSmall) {
            releaseBoss(ctx, 'cleared', out);
            break;
          }
          // (B) timeout: the backstop, and it runs even with smalls still alive.
          timer = Math.max(0, timer - ctx.dt);
          if (timer === 0) releaseBoss(ctx, 'timeout', out);
          break;
        }

        case 'BOSS_ACTIVE': {
          if (!ctx.bossAlive) {
            // The large enemy is down. Whether the wave is over depends on whether
            // its small enemies are, which is what stops "victory" from landing
            // while a Stalker is still chewing on the player.
            if (ctx.smallAlive <= 0) {
              clearWave();
              break;
            }
            phase = 'BOSS_LOCKED';
            timer = 0;
            break;
          }
          if (DIRECTOR.addsWhileBossAlive) {
            addTimer -= ctx.dt;
            if (addTimer <= 0) {
              addTimer += DIRECTOR.addsIntervalWhileBossAlive;
              for (let i = 0; i < DIRECTOR.addsPerTrickle; i += 1) smallOrder(ctx, out);
            }
          }
          break;
        }

        case 'INTERMISSION': {
          timer = Math.max(0, timer - ctx.dt);
          if (timer === 0) enterWave(waveIndex + 1);
          break;
        }

        case 'VICTORY':
        case 'DEFEAT':
        default:
          // Terminal: no spawning, no timers, nothing. This is the trap-table entry
          // "spawning continues after the run ends". The phase is the guard here and
          // `playerDead` above is the other one; both are checked on purpose.
          break;
      }

      publishStatus();
    },

    reset() {
      rng = createRng(seed);
      phase = 'OPENING';
      outcome = 'running';
      waveIndex = 0;
      // The plan for wave 0 is rebuilt when the opening ends. Planning it here as
      // well would draw the jitter twice and make a reset run differ from a fresh one.
      remaining = 0;
      spawnedSmall = 0;
      plannedSmall = 0;
      inFlightSmall = 0;
      inFlightOrders.clear();
      timer = DIRECTOR.openingGracePeriod;
      addTimer = DIRECTOR.addsIntervalWhileBossAlive;
      bossPending = false;
      bossReleased = false;
      lastUnlockReason = 'none';
      chosen.length = 0;
      publishStatus();
    },

    confirmSpawn(orderId) {
      if (!inFlightOrders.delete(orderId)) return;
      inFlightSmall = Math.max(0, inFlightSmall - 1);
      spawnedSmall += 1;
    },

    abandonSpawn(orderId) {
      if (!inFlightOrders.delete(orderId)) return;
      inFlightSmall = Math.max(0, inFlightSmall - 1);
    },

    acceptsPending() {
      return phase !== 'DEFEAT' && phase !== 'VICTORY';
    },
  };
}
