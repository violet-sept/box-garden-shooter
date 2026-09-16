/**
 * The run's director: a fixed script, played out.
 *
 * A state machine that reads "what is true about the world this tick" and produces "what
 * should be spawned". It never touches the enemy store (hard rule 13): the `World`
 * executes the orders. That separation is what lets every transition — the drops, the
 * Warden's gate, the second wave's countdown, the victory — be tested without building a
 * world at all, which matters because "the boss appeared while a Stalker was still alive"
 * is exactly the sort of thing that only fails in a real run.
 *
 * ## The script (phases 10 and 11)
 *
 * ```
 *   t = 0 … 10 s          OPENING            the countdown the HUD shows; nothing on the field
 *   t = 10 … 50 s         DEPLOYING          five drops of 5/5/5/5/10, ten seconds apart
 *   field clear           CLEARING           every drop is out; waiting for the arena to empty
 *   Warden ordered        BOSS_INCOMING      the order is in, the body is not (0.9 s warning)
 *   Warden alive          BOSS_ACTIVE        it is on the field
 *   Warden dead           GUNSHIP_COUNTDOWN  "第二批敌人还有 N 秒到达战场" — 20 s, on the clock
 *   gunship ordered       GUNSHIP_INCOMING   again: the order is in, the body is not
 *   gunship alive         GUNSHIP_ACTIVE     it is on the field
 *   gunship dead          VICTORY
 * ```
 *
 * ## Four rules are load-bearing
 *
 *   1. **The Warden's gate is "the field is clear", and there is no other unlock.** There is
 *      no timeout backstop: a player who never kills the last Stalker never meets the boss.
 *      Both halves of that sentence are the feature.
 *   2. **"Ordered" and "arrived" are two different states.** Phase 3 released the Warden by
 *      setting its phase to `BOSS_ACTIVE` at the moment of the *order*, and then read
 *      `ctx.bossAlive` — which is false until the body exists 0.9 s later. With the field
 *      already cleared, the very next tick took the "`!bossAlive`" branch and declared the
 *      run cleared **during the Warden's own spawn warning** (measured: the wave closed 53
 *      ticks, 0.88 s, before the ordered body appeared; on the final wave that was a victory
 *      with the boss still in its warning). Phase 10 split it into `BOSS_INCOMING`; phase 11
 *      gives the second wave the same pair of phases, because the same mistake would now be
 *      "you win while the gunship is still in its warning".
 *   3. **The second wave's countdown is measured on the run clock, not from "the Warden
 *      died".** It starts on the tick the Warden's body stops existing and ends
 *      `DIRECTOR.secondWaveCountdown` seconds later, so the number on screen and the arrival
 *      cannot drift, and a long frame delays when a beat is *noticed* rather than which
 *      second it belongs to.
 *   4. **Victory is the gunship's death.** The run is not over when the Warden falls: the
 *      brief's second wave is the end of it, and the phase only exists to say so.
 *
 * ## Where the random stream went
 *
 * The old director drew a wave plan from its own RNG (count jitter, so two seeds gave two
 * run shapes). The script has nothing to draw, so the stream now has exactly one job:
 * *where* a body appears. Two runs share a schedule and differ in the ground they fight
 * over.
 */

import { DIRECTOR, type EnemyArchetypeId } from '../../core/config';
import { createRng, type Rng } from '../../core/math/rng';
import { distanceXZ, type Vector3 } from '../../core/math/vec3';
import { pickSpawnPoint } from './spawnPoints';
import { planDeployment, type Deployment } from './deployment';

/** What the director is allowed to know about the world this tick. */
export interface DirectorContext {
  readonly tick: number;
  /**
   * Simulated seconds since the run started.
   *
   * Drop times and the second wave's countdown are measured against this rather than against
   * a per-drop countdown, so the schedule is absolute: a long frame or a hitstop can delay
   * when a drop is *noticed*, never which second it belongs to.
   */
  readonly time: number;
  readonly dt: number;
  readonly playerPosition: Vector3;
  readonly playerYaw: number;
  readonly playerDead: boolean;
  /** Live combatants with the practice dummies already excluded (`liveCount()`). */
  readonly smallAlive: number;
  readonly bossAlive: boolean;
  /** Live gunships. Only ever 0 or 1, and never 1 while `bossAlive` is true. */
  readonly gunshipAlive: boolean;
}

/** One "spawn here" order. */
export interface SpawnCommand {
  /**
   * Unique per order.
   *
   * The world confirms every order exactly once — with `confirmSpawn` when the body is
   * created, or `abandonSpawn` when the run ended first. Matching on the id rather than on
   * position is what makes the two idempotent and keeps a late confirmation from being
   * credited to a different order.
   */
  readonly orderId: number;
  readonly position: Vector3;
  /** Seconds the ground warning runs before the body appears. */
  readonly warning: number;
  /**
   * What to spawn.
   *
   * The archetype itself rather than the old `boss: boolean`: with three archetypes in the
   * script a flag would have to grow a second flag next to it, and the world's job here is
   * literally "make this kind of enemy at this point".
   */
  readonly archetype: EnemyArchetypeId;
}

/** Which phase the machine is in. Kept as values so tests can read it directly. */
export type DirectorPhase =
  | 'OPENING'
  | 'DEPLOYING'
  | 'CLEARING'
  | 'BOSS_INCOMING'
  | 'BOSS_ACTIVE'
  | 'GUNSHIP_COUNTDOWN'
  | 'GUNSHIP_INCOMING'
  | 'GUNSHIP_ACTIVE'
  | 'VICTORY'
  | 'DEFEAT';

/** The run's outcome, or `'running'` while it is still going. */
export type RunOutcome = 'running' | 'victory' | 'defeat';

/**
 * Which countdown is on screen, if any.
 *
 * `1` and `2` are the two the run has — the opening and the second wave — and they are
 * numbered rather than named because the number *is* the text the HUD prints
 * ("第 N 批敌人还有 …"). Zero means "there is no countdown right now", which is every other
 * phase: drops two through five are announced by the ground ring and the spawn blip, not by a
 * clock at the top of the screen.
 */
export type CountdownWave = 0 | 1 | 2;

/** Broadcast facts the world turns into events. */
export interface DirectorEvents {
  /** The run's first tick: the countdown is on screen and the first drop is coming. */
  assaultStarted(script: Deployment): void;
  /** Every drop is out and the arena is empty — the beat before the Warden. */
  fieldCleared(totalSmall: number): void;
  /**
   * The Warden is down and the second wave's countdown has started.
   *
   * The seconds are on the payload so the announcement can name the wait; the *live* number
   * is on {@link DirectorStatus.countdownSeconds}, which the HUD reads every frame.
   */
  secondWave(seconds: number, archetype: EnemyArchetypeId): void;
  /**
   * An enemy has been ordered.
   *
   * The archetype is on the order itself, so there is one channel for "what is coming"
   * rather than an order plus a parallel parameter that could disagree with it.
   */
  spawnPending(order: SpawnCommand): void;
  runEnded(outcome: 'victory' | 'defeat'): void;
}

/** Read-only snapshot for the HUD and the debug panel. */
export interface DirectorStatus {
  phase: DirectorPhase;
  outcome: RunOutcome;
  /**
   * 1-based number of the next drop, clamped to the last one once they are all out.
   *
   * 1-based because it is the number a player would say out loud ("第三批"), which is the
   * same reason the wave number used to be.
   */
  batch: number;
  totalBatches: number;
  /** Drops released so far. Diagnostics, and what `remaining` is derived from. */
  dropsReleased: number;
  /** Small enemies still to be released. */
  remaining: number;
  /**
   * The countdown on screen, in seconds: the next drop during the opening, the second wave
   * after the Warden. Zero whenever no clock is running, which is what hides the element.
   */
  countdownSeconds: number;
  /** Which countdown {@link countdownSeconds} belongs to. Zero means none. */
  countdownWave: CountdownWave;
  /**
   * The release bookkeeping, exposed so a test can assert it rather than infer it:
   * `spawnedSmall` is how many bodies have actually appeared, `inFlightSmall` how many
   * orders are issued but not yet reflected in `smallAlive`, and `plannedSmall` is what
   * the script will have released by the end.
   */
  spawnedSmall: number;
  inFlightSmall: number;
  plannedSmall: number;
  /** True while the run still owes the player a Warden. */
  bossPending: boolean;
  /** False while the Warden is ordered but its body does not exist yet. */
  bossArrived: boolean;
  /** False until the Warden's order has been issued. Diagnostics, not rules. */
  bossReleased: boolean;
  /** True while the run still owes the player a second wave. */
  gunshipPending: boolean;
  /** False while the gunship is ordered but its body does not exist yet. */
  gunshipArrived: boolean;
  /** False until the gunship's order has been issued. Diagnostics, not rules. */
  gunshipReleased: boolean;
}

/** The director's public surface. */
export interface Director {
  readonly status: DirectorStatus;
  /**
   * Advances one tick and appends this tick's spawn orders to `out`.
   *
   * A whole drop can be issued in one tick (a drop is five or ten bodies), which is the
   * one place this differs in feel from phase 3's one-at-a-time trickle: the drops *are*
   * the cadence now, and the ten-second gap between them is what keeps thirty Stalkers
   * from being a wall.
   */
  tick(ctx: DirectorContext, out: SpawnCommand[]): void;
  /** Back to the opening countdown, with a fresh random stream and a fresh script. */
  reset(): void;
  /**
   * Reports that an ordered enemy now exists in the world.
   *
   * Idempotent, and ignored for unknown ids. The in-flight count is what keeps "the field
   * is clear" honest: an order is in flight from the moment it is issued until the body
   * appears or is abandoned, so a drop that has been ordered but not yet landed cannot be
   * mistaken for a field with nothing left in it.
   */
  confirmSpawn(orderId: number): void;
  /** Reports that an ordered enemy will never appear. Idempotent. */
  abandonSpawn(orderId: number): void;
  /**
   * Whether a queued spawn is still legal.
   *
   * The world re-checks this after the warning delay: by then the player may have died,
   * which must cancel the whole run rather than deliver one last enemy onto a results
   * screen.
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

  /**
   * The resolved script.
   *
   * Built once per run, never per tick, and rebuilt on `reset()` so a test that changes
   * `DIRECTOR_TUNING` between runs gets the script it asked for.
   */
  let script: Deployment = planDeployment();

  let phase: DirectorPhase = 'OPENING';
  let outcome: RunOutcome = 'running';
  /** Index of the next drop to release. */
  let nextDrop = 0;
  /** Small enemies already released by the drops that have gone out. */
  let releasedSmall = 0;
  /** Set the moment the Warden is ordered, so it can only happen once. */
  let bossReleased = false;
  /** Set when the Warden's body is first seen. The gate between the two boss phases. */
  let bossArrived = false;
  /** The same pair for the second wave. */
  let gunshipReleased = false;
  let gunshipArrived = false;
  /** Run clock at which the second wave's countdown started. */
  let secondWaveAt = 0;
  /** Small enemies whose body has appeared. Diagnostics. */
  let spawnedSmall = 0;
  /** Orders issued but not yet reflected in `ctx.smallAlive`. */
  let inFlightSmall = 0;
  /** Ids of the orders counted in {@link inFlightSmall}. */
  const inFlightOrders = new Set<number>();
  let nextOrderId = 1;
  /** Whether the run's opening has been announced. */
  let announced = false;
  /** The run clock as of the last tick, so `publishStatus` can derive `timer`. */
  let elapsed = 0;

  /** Points already chosen this tick, so one drop stays spread out. */
  const chosen: Vector3[] = [];

  const status: DirectorStatus = {
    phase: 'OPENING',
    outcome: 'running',
    batch: 1,
    totalBatches: 0,
    dropsReleased: 0,
    remaining: 0,
    countdownSeconds: script.firstDropAt,
    countdownWave: 1,
    spawnedSmall: 0,
    inFlightSmall: 0,
    plannedSmall: 0,
    bossPending: false,
    bossArrived: false,
    bossReleased: false,
    gunshipPending: false,
    gunshipArrived: false,
    gunshipReleased: false,
  };

  /** The drop that is due next, or `undefined` once they are all out. */
  const pendingDrop = () => (nextDrop < script.totalDrops ? script.drops[nextDrop] : undefined);

  const publishStatus = (): void => {
    status.phase = phase;
    status.outcome = outcome;
    status.batch = Math.min(nextDrop + 1, Math.max(1, script.totalDrops));
    status.totalBatches = script.totalDrops;
    status.dropsReleased = nextDrop;
    status.remaining = Math.max(0, script.totalSmall - releasedSmall);
    status.spawnedSmall = spawnedSmall;
    status.inFlightSmall = inFlightSmall;
    status.plannedSmall = script.totalSmall;
    status.bossPending = !bossReleased && outcome === 'running';
    status.bossArrived = bossArrived;
    status.bossReleased = bossReleased;
    status.gunshipPending = bossReleased && !gunshipReleased && outcome === 'running';
    status.gunshipArrived = gunshipArrived;
    status.gunshipReleased = gunshipReleased;

    // Both countdowns are *derived* from the clock rather than decremented, so neither can
    // drift from the times the beats are actually measured against.
    if (phase === 'GUNSHIP_COUNTDOWN') {
      status.countdownWave = 2;
      status.countdownSeconds = Math.max(0, secondWaveAt + DIRECTOR.secondWaveCountdown - elapsed);
    } else {
      const drop = phase === 'OPENING' || phase === 'DEPLOYING' ? pendingDrop() : undefined;
      // Wave 1 is the opening only. `DEPLOYING` still has a live timer (the next drop), but
      // no countdown element: drops two through five are announced by their ground rings, and
      // a clock at the top of the screen would stop meaning "brace yourself".
      status.countdownWave = phase === 'OPENING' ? 1 : 0;
      status.countdownSeconds = drop ? Math.max(0, drop.at - elapsed) : 0;
    }
  };

  /**
   * Chooses a spawn point for one order.
   *
   * The tick's already-chosen points are passed in so a drop stays spread out. The large
   * enemy is checked again against the others: two bodies inside each other at the arena
   * edge is the one placement the spawn rules cannot catch, because each point is
   * individually legal.
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

  const enterWin = (): void => {
    phase = 'VICTORY';
    outcome = 'victory';
    events.runEnded('victory');
  };

  const enterDefeat = (): void => {
    phase = 'DEFEAT';
    outcome = 'defeat';
    // Everything already ordered is dropped by the world, which asks `acceptsPending()`
    // before it releases a queued body. Without that the player watches reinforcements
    // walk in over their own results screen.
    events.runEnded('defeat');
  };

  const smallOrder = (ctx: DirectorContext, out: SpawnCommand[]): void => {
    const order: SpawnCommand = {
      orderId: nextOrderId++,
      position: pickPoint(ctx, false),
      warning: DIRECTOR.spawnWarningDuration,
      archetype: 'small',
    };
    inFlightSmall += 1;
    inFlightOrders.add(order.orderId);
    out.push(order);
    events.spawnPending(order);
  };

  /**
   * Releases the Warden. The one and only caller is the clear check below, and the guard
   * is what makes "exactly one Warden per run" a property of the code rather than of the
   * state machine's shape.
   */
  const releaseBoss = (ctx: DirectorContext, out: SpawnCommand[]): void => {
    if (bossReleased) return;
    bossReleased = true;
    // Ordered, not arrived: `BOSS_INCOMING` is the phase that waits for the body, which
    // is what stops the very next tick from reading `bossAlive === false` as "it died".
    phase = 'BOSS_INCOMING';
    const order: SpawnCommand = {
      orderId: nextOrderId++,
      position: pickPoint(ctx, true),
      warning: DIRECTOR.spawnWarningDuration,
      archetype: 'large',
    };
    out.push(order);
    events.spawnPending(order);
  };

  /**
   * Releases the second wave, once the countdown has run out.
   *
   * Guarded like the Warden's release, and for the same reason: "exactly one gunship per run"
   * should be a property of this function rather than of the shape of the phase machine that
   * calls it.
   */
  const releaseGunship = (ctx: DirectorContext, out: SpawnCommand[]): void => {
    if (gunshipReleased) return;
    gunshipReleased = true;
    phase = 'GUNSHIP_INCOMING';
    const order: SpawnCommand = {
      orderId: nextOrderId++,
      position: pickPoint(ctx, true),
      warning: DIRECTOR.spawnWarningDuration,
      archetype: 'helicopter',
    };
    out.push(order);
    events.spawnPending(order);
  };

  return {
    get status() {
      publishStatus();
      return status;
    },

    tick(ctx, out) {
      out.length = 0;
      chosen.length = 0;
      elapsed = ctx.time;

      if (!announced) {
        announced = true;
        events.assaultStarted(script);
      }

      // Death ends the run from anywhere, including part-way through a drop or during the
      // second wave's countdown. The phase guard is what the trap table asks for:
      // `playerDead` *and* the phase, never either alone.
      if (ctx.playerDead) {
        if (phase !== 'DEFEAT' && phase !== 'VICTORY') enterDefeat();
        publishStatus();
        return;
      }

      switch (phase) {
        case 'OPENING':
        case 'DEPLOYING': {
          // A `while` rather than an `if`: at 60 Hz one tick cannot cross two drop
          // boundaries ten seconds apart, but the loop is what makes "one drop per
          // boundary, never two, never none" a property of the schedule instead of a
          // property of the tick rate.
          let drop = pendingDrop();
          while (drop && ctx.time >= drop.at) {
            releasedSmall += drop.count;
            for (let i = 0; i < drop.count; i += 1) smallOrder(ctx, out);
            nextDrop += 1;
            drop = pendingDrop();
          }
          if (nextDrop >= script.totalDrops) {
            // Every drop is out. Whether the arena is empty is the next case's business:
            // the orders issued above are still in flight on this tick, so there is
            // nothing to decide yet.
            phase = 'CLEARING';
            break;
          }
          phase = nextDrop === 0 ? 'OPENING' : 'DEPLOYING';
          break;
        }

        case 'CLEARING': {
          // "Nothing alive and nothing on the way" is the whole condition. It is *not*
          // `spawnedSmall >= plannedSmall` as well: that clause would enumerate the bodies
          // rather than the field, and an order the world ever abandoned (the release
          // queue's ceiling) would leave the run waiting for an enemy that is never
          // coming. The field the player sees is the thing being tested.
          if (ctx.smallAlive <= 0 && inFlightSmall <= 0) {
            events.fieldCleared(script.totalSmall);
            releaseBoss(ctx, out);
          }
          break;
        }

        case 'BOSS_INCOMING': {
          // The body has to be seen before it can be missed (see the header).
          if (ctx.bossAlive) {
            bossArrived = true;
            phase = 'BOSS_ACTIVE';
          }
          break;
        }

        case 'BOSS_ACTIVE': {
          if (!ctx.bossAlive) {
            // The Warden is down. The run is **not** over: the second wave is announced here,
            // on the same tick its body leaves the field, so the countdown the player reads
            // is measured from the moment the fight actually ended.
            secondWaveAt = elapsed;
            phase = 'GUNSHIP_COUNTDOWN';
            events.secondWave(DIRECTOR.secondWaveCountdown, 'helicopter');
          }
          break;
        }

        case 'GUNSHIP_COUNTDOWN': {
          if (ctx.time >= secondWaveAt + DIRECTOR.secondWaveCountdown) releaseGunship(ctx, out);
          break;
        }

        case 'GUNSHIP_INCOMING': {
          // Same rule as the Warden's: a victory declared during the arrival warning would be
          // a victory over an enemy whose body has not been built yet.
          if (ctx.gunshipAlive) {
            gunshipArrived = true;
            phase = 'GUNSHIP_ACTIVE';
          }
          break;
        }

        case 'GUNSHIP_ACTIVE': {
          if (!ctx.gunshipAlive) enterWin();
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
      // Re-resolved rather than reused: a test (or a designer) that changes the script
      // between two runs must get the new one, and `planDeployment` is the only thing that
      // reads it.
      script = planDeployment();
      phase = 'OPENING';
      outcome = 'running';
      nextDrop = 0;
      releasedSmall = 0;
      bossReleased = false;
      bossArrived = false;
      gunshipReleased = false;
      gunshipArrived = false;
      secondWaveAt = 0;
      spawnedSmall = 0;
      inFlightSmall = 0;
      inFlightOrders.clear();
      chosen.length = 0;
      // The opening is announced again by the first tick of the new run, which is also
      // what makes a restart show the countdown rather than start mid-silence.
      announced = false;
      elapsed = 0;
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
