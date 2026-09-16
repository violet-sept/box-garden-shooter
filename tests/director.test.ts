/**
 * The run's director.
 *
 * ## What this file is really guarding
 *
 * Three sentences, and each one is a test that would otherwise only fail in a real run:
 *
 *   1. **Nothing appears for the first ten seconds** (the countdown), and then the drops
 *      arrive on the script's own times — five, ten, thirty, never more.
 *   2. **The Warden is released when the field is clear and at no other moment.** Not on a
 *      timer, not while a Stalker is alive, not while a drop's bodies are still in their
 *      warnings.
 *   3. **"Ordered" is not "arrived".** Phase 3 read `bossAlive` on the tick after it ordered
 *      the Warden, which is false for the whole 0.9 s spawn warning, so the run was declared
 *      clear *during* the warning (measured: 53 ticks early; on the last wave that was a
 *      victory with the boss still incoming). The harness below therefore delivers bodies
 *      the way `World` does — after the warning — which is what makes that regression
 *      testable at all. The old harness marked the boss alive on the tick it was ordered and
 *      could not see it.
 *   4. **The Warden's death is not the end of the run** (phase 11). It starts a twenty-second
 *      countdown, and *that* is followed by the same order-then-arrive pair for the gunship.
 *      Victory belongs to the second wave's death alone, so a run that stops here would now
 *      be a run that ends one boss early.
 *
 * Everything here is plain data: a context is a struct literal, and the "world" is a small
 * record with a clock on it.
 */

import { describe, expect, it } from 'vitest';
import { DIRECTOR, DIRECTOR_TUNING } from '#/core/config';
import type { Vector3 } from '#/core/math/vec3';
import { createDirector, type SpawnCommand } from '#/game/director/Director';
import { planDeployment, type Deployment } from '#/game/director/deployment';

const DT = 1 / 60;
const PLAYER: Vector3 = { x: 0, y: 0, z: 8 };

/**
 * The world the director reads, modelled the way `World` actually delivers orders.
 *
 * `inWarning` is the whole point: an order that has been issued is *not* a body, so
 * `smallAlive` and `bossAlive` stay untouched until its warning has run out.
 */
interface FakeWorld {
  smallAlive: number;
  bossAlive: boolean;
  gunshipAlive: boolean;
  playerDead: boolean;
  time: number;
  readonly inWarning: { order: SpawnCommand; remaining: number }[];
}

function harness(seed = 5) {
  const world: FakeWorld = {
    smallAlive: 0,
    bossAlive: false,
    gunshipAlive: false,
    playerDead: false,
    time: 0,
    inWarning: [],
  };
  const started: Deployment[] = [];
  const cleared: number[] = [];
  const pending: { command: SpawnCommand; archetype: string }[] = [];
  const smallOrders: SpawnCommand[] = [];
  const bossOrders: SpawnCommand[] = [];
  const gunshipOrders: SpawnCommand[] = [];
  /** The second wave's announcements, as `{ seconds, archetype }`. */
  const secondWaves: { seconds: number; archetype: string }[] = [];
  /** Release times, on the run clock, of each small / boss order. */
  const orderTimes: number[] = [];
  const bossOrderTimes: number[] = [];
  const gunshipOrderTimes: number[] = [];
  const ended: string[] = [];
  /** Set by `step`, so the event handlers can stamp themselves with the run clock. */
  const clock = { value: 0 };

  const director = createDirector({
    seed,
    events: {
      assaultStarted(script) {
        started.push(script);
      },
      fieldCleared(totalSmall) {
        cleared.push(totalSmall);
      },
      secondWave(seconds, archetype) {
        secondWaves.push({ seconds, archetype });
      },
      spawnPending(order) {
        pending.push({ command: order, archetype: order.archetype });
        if (order.archetype === 'small') {
          smallOrders.push(order);
          orderTimes.push(clock.value);
        } else if (order.archetype === 'large') {
          bossOrders.push(order);
          bossOrderTimes.push(clock.value);
        } else {
          gunshipOrders.push(order);
          gunshipOrderTimes.push(clock.value);
        }
      },
      runEnded(outcome) {
        ended.push(outcome);
      },
    },
  });

  return {
    director,
    world,
    clock,
    started,
    cleared,
    pending,
    smallOrders,
    bossOrders,
    gunshipOrders,
    secondWaves,
    orderTimes,
    bossOrderTimes,
    gunshipOrderTimes,
    ended,
  };
}

type Harness = ReturnType<typeof harness>;

/** The director's per-tick view of the fake world. */
function contextFor(world: FakeWorld, dt: number) {
  return {
    tick: Math.round(world.time / dt),
    time: world.time,
    dt,
    playerPosition: PLAYER,
    playerYaw: 0,
    playerDead: world.playerDead,
    smallAlive: world.smallAlive,
    bossAlive: world.bossAlive,
    gunshipAlive: world.gunshipAlive,
  };
}

/** One tick, including the delivery of whatever warning has run out. */
function step(h: Harness, dt = DT): SpawnCommand[] {
  h.world.time += dt;
  h.clock.value = h.world.time;
  const produced: SpawnCommand[] = [];
  h.director.tick(contextFor(h.world, dt), produced);
  for (const order of produced) h.world.inWarning.push({ order, remaining: order.warning });
  for (let i = h.world.inWarning.length - 1; i >= 0; i -= 1) {
    const queued = h.world.inWarning[i];
    if (!queued) continue;
    queued.remaining -= dt;
    if (queued.remaining > 0) continue;
    h.world.inWarning.splice(i, 1);
    h.director.confirmSpawn(queued.order.orderId);
    if (queued.order.archetype === 'small') h.world.smallAlive += 1;
    else if (queued.order.archetype === 'large') h.world.bossAlive = true;
    else h.world.gunshipAlive = true;
  }
  return produced;
}

/** One tick, then the player finishes whatever is on the field. */
function stepVictorious(h: Harness, dt = DT): SpawnCommand[] {
  const produced = step(h, dt);
  h.world.smallAlive = 0;
  // A heavy is only removed once the director has *seen* it: a body that appeared at the end
  // of this tick cannot have been shot during it (the world's release queue runs after the
  // shot), so the harness must not shoot it either — otherwise `BOSS_INCOMING` (or
  // `GUNSHIP_INCOMING`) would never become its `_ACTIVE` phase and the run would sit there
  // for ever.
  const phase = h.director.status.phase;
  if (phase === 'BOSS_ACTIVE') h.world.bossAlive = false;
  if (phase === 'GUNSHIP_ACTIVE') h.world.gunshipAlive = false;
  return produced;
}

/** Runs ticks until `done`, or throws with the phase it got stuck in. */
function stepUntil(h: Harness, done: () => boolean, limit = 60 * 60 * 5): void {
  for (let i = 0; i < limit; i += 1) {
    step(h);
    if (done()) return;
  }
  throw new Error(`condition never met; phase is ${h.director.status.phase}`);
}

/** Runs the director forward with the player killing everything, until `done`. */
function playUntil(h: Harness, done: () => boolean, limit = 60 * 60 * 5): void {
  for (let i = 0; i < limit; i += 1) {
    stepVictorious(h);
    if (done()) return;
  }
  throw new Error(`condition never met; phase is ${h.director.status.phase}`);
}

/** The run clock at each drop release, collapsed from the per-order times. */
function dropTimes(h: Harness): number[] {
  const times: number[] = [];
  for (const time of h.orderTimes) {
    const last = times[times.length - 1];
    if (last === undefined || time - last > DT / 2) times.push(time);
  }
  return times;
}

/** How many enemies each drop released, in order. */
function dropSizes(h: Harness): number[] {
  const sizes: number[] = [];
  let previous: number | undefined;
  for (const time of h.orderTimes) {
    if (previous !== undefined && time - previous <= DT / 2) {
      sizes[sizes.length - 1] = (sizes[sizes.length - 1] ?? 0) + 1;
    } else {
      sizes.push(1);
    }
    previous = time;
  }
  return sizes;
}

describe('director: the opening countdown', () => {
  it('holds the field empty for the countdown, then starts the drops', () => {
    const h = harness();
    expect(h.director.status.phase).toBe('OPENING');
    expect(h.director.status.countdownSeconds).toBeCloseTo(DIRECTOR.openingCountdown, 6);

    // Just short of the countdown: nothing has been ordered at all.
    const ticks = Math.floor(DIRECTOR.openingCountdown / DT) - 2;
    for (let i = 0; i < ticks; i += 1) {
      expect(step(h)).toHaveLength(0);
    }
    expect(h.smallOrders).toHaveLength(0);
    expect(h.director.status.phase).toBe('OPENING');

    stepUntil(h, () => h.smallOrders.length > 0);
    expect(h.director.status.phase).toBe('DEPLOYING');
    expect(h.smallOrders).toHaveLength(5);
  });

  it('counts the timer down to the first drop and not past it', () => {
    const h = harness();
    let previous = h.director.status.countdownSeconds;
    for (let i = 0; i < Math.floor(DIRECTOR.openingCountdown / DT) - 1; i += 1) {
      step(h);
      const timer = h.director.status.countdownSeconds;
      expect(timer).toBeLessThanOrEqual(previous);
      expect(timer).toBeGreaterThan(0);
      previous = timer;
      expect(h.director.status.phase).toBe('OPENING');
    }
    // The tick the countdown reaches zero is the tick the first drop is released, and the
    // phase (and therefore the on-screen countdown) is gone with it.
    step(h);
    expect(h.smallOrders).toHaveLength(5);
    expect(h.director.status.phase).toBe('DEPLOYING');
    expect(h.director.status.countdownSeconds).toBeCloseTo(DIRECTOR.batchInterval, 1);
  });

  it('announces the assault once, on the first tick, with the script in hand', () => {
    const h = harness();
    expect(h.started).toHaveLength(0);
    step(h);
    expect(h.started).toHaveLength(1);
    expect(h.started[0]?.totalSmall).toBe(30);
    expect(h.started[0]?.totalDrops).toBe(5);
    expect(h.started[0]?.firstDropAt).toBe(DIRECTOR.openingCountdown);
    for (let i = 0; i < 600; i += 1) step(h);
    expect(h.started).toHaveLength(1);
  });
});

describe('director: the drops', () => {
  it('releases the scripted drops on the scripted times', () => {
    const h = harness();
    const script = planDeployment();
    stepUntil(h, () => h.director.status.dropsReleased === script.totalDrops);
    expect(dropSizes(h)).toEqual([5, 5, 5, 5, 10]);
    const times = dropTimes(h);
    expect(times).toHaveLength(script.totalDrops);
    script.drops.forEach((drop, index) => {
      expect(times[index]).toBeCloseTo(drop.at, 1);
    });
    // Ten seconds apart, which is the part the player feels.
    for (let i = 1; i < times.length; i += 1) {
      expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeCloseTo(DIRECTOR.batchInterval, 1);
    }
  });

  it('releases exactly thirty, and then stops for ever', () => {
    const h = harness();
    // Never kill anything: the arena fills, which is also the case a cap used to clip.
    for (let i = 0; i < 60 * 60 * 3; i += 1) step(h);
    expect(h.smallOrders).toHaveLength(30);
    expect(h.director.status.plannedSmall).toBe(30);
    expect(h.director.status.remaining).toBe(0);
    expect(h.director.status.phase).toBe('CLEARING');
    // Nothing more is even considered while the field is full.
    expect(h.director.status.inFlightSmall).toBe(0);
    expect(h.world.smallAlive).toBe(30);
  });

  it('reports each drop through the status the HUD and the debug panel read', () => {
    const h = harness();
    expect(h.director.status.batch).toBe(1);
    expect(h.director.status.remaining).toBe(30);
    stepUntil(h, () => h.director.status.dropsReleased === 1);
    expect(h.director.status.batch).toBe(2);
    expect(h.director.status.remaining).toBe(25);
    stepUntil(h, () => h.director.status.dropsReleased === 5);
    // Clamped at the last drop rather than reading "6 / 5".
    expect(h.director.status.batch).toBe(5);
    expect(h.director.status.totalBatches).toBe(5);
    expect(h.director.status.remaining).toBe(0);
  });

  it('spreads a drop over several points rather than stacking it on one', () => {
    const h = harness();
    stepUntil(h, () => h.smallOrders.length >= 5);
    const first = h.smallOrders.slice(0, 5);
    for (let i = 1; i < first.length; i += 1) {
      const a = first[i - 1]?.position;
      const b = first[i]?.position;
      if (!a || !b) throw new Error('missing order');
      expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(0);
    }
  });
});

describe('director: the Warden’s gate', () => {
  it('will not release the Warden while a Stalker is still alive', () => {
    const h = harness();
    // Play out the whole script, keeping one enemy alive for ever.
    for (let i = 0; i < 60 * 60 * 3; i += 1) {
      step(h);
      h.world.smallAlive = Math.max(1, h.world.smallAlive);
    }
    expect(h.director.status.phase).toBe('CLEARING');
    expect(h.bossOrders).toHaveLength(0);
    expect(h.cleared).toHaveLength(0);
    expect(h.ended).toHaveLength(0);
  });

  it('will not release the Warden while a drop’s bodies are still in their warnings', () => {
    const h = harness();
    // Hold every announced body in its warning for ever, and keep the field empty: the run
    // must not read "nothing alive" as "nothing left".
    for (let i = 0; i < 60 * 60 * 3; i += 1) {
      step(h);
      for (const queued of h.world.inWarning) queued.remaining = 10_000;
      h.world.smallAlive = 0;
    }
    expect(h.director.status.inFlightSmall).toBe(30);
    expect(h.bossOrders).toHaveLength(0);
    expect(h.director.status.phase).toBe('CLEARING');
  });

  it('releases it — once — as soon as the field is clear', () => {
    const h = harness();
    playUntil(h, () => h.bossOrders.length > 0);
    expect(h.cleared).toEqual([30]);
    expect(h.bossOrders).toHaveLength(1);
    expect(h.bossOrders[0]?.archetype).toBe('large');

    // And it is a *gate*, not a coincidence: another minute of empty field adds nothing.
    for (let i = 0; i < 60 * 60; i += 1) {
      step(h);
      h.world.smallAlive = 0;
    }
    expect(h.bossOrders).toHaveLength(1);
  });

  it('does not release it before the last drop is even out', () => {
    const h = harness();
    // The player kills everything as it appears. The Warden still waits for the script.
    playUntil(h, () => h.bossOrders.length > 0);
    const lastDropAt = planDeployment().drops.at(-1)?.at ?? 0;
    expect(h.bossOrderTimes[0]).toBeGreaterThanOrEqual(lastDropAt);
    expect(h.director.status.dropsReleased).toBe(5);
  });

  it('orders the Warden but does not call it arrived, and does not win during the warning', () => {
    // The phase-3 regression, pinned. `bossAlive` is false for the whole spawn warning,
    // and "the field is empty" is true for the whole of it too — so a state machine that
    // only asks about `bossAlive` declares the run over before the boss lands.
    const h = harness();
    playUntil(h, () => h.bossOrders.length > 0);
    expect(h.director.status.phase).toBe('BOSS_INCOMING');
    expect(h.director.status.bossReleased).toBe(true);
    expect(h.director.status.bossArrived).toBe(false);

    const warningTicks = Math.floor(DIRECTOR.spawnWarningDuration / DT) - 2;
    for (let i = 0; i < warningTicks; i += 1) {
      step(h);
      expect(h.director.status.phase).toBe('BOSS_INCOMING');
      expect(h.director.status.bossArrived).toBe(false);
      expect(h.world.bossAlive).toBe(false);
      expect(h.ended).toHaveLength(0);
    }

    // The body lands on the world's side of the tick, so the director sees it on the tick
    // *after* it exists — and only then may the run stop being "incoming".
    stepUntil(h, () => h.world.bossAlive);
    step(h);
    expect(h.director.status.phase).toBe('BOSS_ACTIVE');
    expect(h.director.status.bossArrived).toBe(true);
    expect(h.ended).toHaveLength(0);
    // One order in total: the boss phases do not re-order it.
    expect(h.bossOrders).toHaveLength(1);
  });
});

describe('director: the second wave', () => {
  /**
   * Plays out the Stalkers and the Warden, then takes the tick that *sees* the Warden die.
   *
   * `playUntil` stops the moment the Warden's body is first visible (that is what
   * `BOSS_ACTIVE` means), and its own `stepVictorious` has already cleared the field — so one
   * more plain `step` is the tick on which the director reads "the Warden is not alive" and
   * opens the countdown. Returns the run clock at that instant, which is what the countdown is
   * measured from.
   */
  function toSecondWave(h: Harness): number {
    playUntil(h, () => h.director.status.phase === 'BOSS_ACTIVE');
    step(h);
    expect(h.director.status.phase).toBe('GUNSHIP_COUNTDOWN');
    return h.world.time;
  }

  it('announces the second wave on the tick the Warden dies, and counts twenty seconds', () => {
    const h = harness();
    const wardenDiedAt = toSecondWave(h);

    expect(h.secondWaves).toEqual([{ seconds: DIRECTOR.secondWaveCountdown, archetype: 'helicopter' }]);
    expect(h.director.status.countdownWave).toBe(2);
    expect(h.director.status.countdownSeconds).toBeCloseTo(DIRECTOR.secondWaveCountdown, 6);
    expect(h.director.status.gunshipPending).toBe(true);
    expect(h.director.status.gunshipReleased).toBe(false);
    expect(h.gunshipOrders).toHaveLength(0);

    // Monotone down, strictly positive, and nothing ordered while it runs.
    let previous = h.director.status.countdownSeconds;
    const ticks = Math.floor(DIRECTOR.secondWaveCountdown / DT) - 2;
    for (let i = 0; i < ticks; i += 1) {
      step(h);
      const remaining = h.director.status.countdownSeconds;
      expect(remaining).toBeLessThanOrEqual(previous);
      expect(remaining).toBeGreaterThan(0);
      previous = remaining;
      expect(h.director.status.phase).toBe('GUNSHIP_COUNTDOWN');
      expect(h.gunshipOrders).toHaveLength(0);
    }

    stepUntil(h, () => h.gunshipOrders.length > 0);
    const orderedAt = h.gunshipOrderTimes[0] ?? 0;
    expect(h.gunshipOrders[0]?.archetype).toBe('helicopter');
    // Measured on the run clock, from the tick the Warden's body left the field — the same
    // absolute-schedule rule the drops use, so a long frame cannot stretch the wait.
    expect(orderedAt - wardenDiedAt).toBeGreaterThanOrEqual(DIRECTOR.secondWaveCountdown - DT);
    expect(orderedAt - wardenDiedAt).toBeLessThan(DIRECTOR.secondWaveCountdown + DT);
    expect(h.director.status.phase).toBe('GUNSHIP_INCOMING');
    // The countdown element goes away with the order: one clock, and it stops reporting the
    // moment there is nothing left to count.
    expect(h.director.status.countdownWave).toBe(0);
    expect(h.director.status.countdownSeconds).toBe(0);
  });

  it('orders the gunship but does not call it arrived, and does not win during its warning', () => {
    // The same regression as the Warden's, one boss later: `gunshipAlive` is false for the
    // whole 0.9 s warning, and the field is empty for the whole of it too — so a machine that
    // only asked about `gunshipAlive` would win the run over an enemy that does not exist yet.
    const h = harness();
    toSecondWave(h);
    stepUntil(h, () => h.gunshipOrders.length > 0);
    expect(h.director.status.phase).toBe('GUNSHIP_INCOMING');
    expect(h.director.status.gunshipReleased).toBe(true);
    expect(h.director.status.gunshipArrived).toBe(false);

    const warningTicks = Math.floor(DIRECTOR.spawnWarningDuration / DT) - 2;
    for (let i = 0; i < warningTicks; i += 1) {
      step(h);
      expect(h.director.status.phase).toBe('GUNSHIP_INCOMING');
      expect(h.director.status.gunshipArrived).toBe(false);
      expect(h.world.gunshipAlive).toBe(false);
      expect(h.ended).toHaveLength(0);
    }

    stepUntil(h, () => h.world.gunshipAlive);
    step(h);
    expect(h.director.status.phase).toBe('GUNSHIP_ACTIVE');
    expect(h.director.status.gunshipArrived).toBe(true);
    expect(h.ended).toHaveLength(0);
    // One order in total: the second wave's phases do not re-order it.
    expect(h.gunshipOrders).toHaveLength(1);
  });

  it('never reports victory while the gunship is still flying, and reports it once when it falls', () => {
    const h = harness();
    toSecondWave(h);
    playUntil(h, () => h.director.status.phase === 'GUNSHIP_ACTIVE');

    for (let i = 0; i < 60 * 120; i += 1) {
      // Set the body *before* the tick, so the run has to notice a gunship that is standing:
      // editing it after the tick would let the director's verdict go unread.
      h.world.gunshipAlive = true;
      step(h);
    }
    expect(h.ended).toHaveLength(0);
    expect(h.director.status.phase).toBe('GUNSHIP_ACTIVE');

    h.world.gunshipAlive = false;
    step(h);
    expect(h.director.status.phase).toBe('VICTORY');
    expect(h.ended).toEqual(['victory']);
    for (let i = 0; i < 120; i += 1) step(h);
    expect(h.ended).toEqual(['victory']);
  });

  it('does not open the countdown while the small enemies are still alive', () => {
    // The gate is the field, not a clock: a player who leaves one Stalker standing never sees
    // the second wave's countdown either, because they never finish the first one.
    const h = harness();
    for (let i = 0; i < 60 * 60 * 3; i += 1) {
      step(h);
      h.world.smallAlive = Math.max(1, h.world.smallAlive);
    }
    expect(h.secondWaves).toHaveLength(0);
    expect(h.director.status.countdownWave).toBe(0);
    expect(h.director.status.phase).toBe('CLEARING');
  });
});

describe('director: ending the run', () => {
  it('enters DEFEAT when the player dies, from any phase', () => {
    const phases = [
      'opening',
      'deploying',
      'clearing',
      'boss-incoming',
      'boss-active',
      'gunship-countdown',
      'gunship-incoming',
      'gunship-active',
    ] as const;
    for (const phase of phases) {
      const h = harness();
      if (phase === 'opening') {
        step(h);
      } else if (phase === 'deploying') {
        stepUntil(h, () => h.smallOrders.length > 0);
      } else if (phase === 'clearing') {
        stepUntil(h, () => h.director.status.dropsReleased === 5);
      } else if (phase === 'boss-incoming') {
        playUntil(h, () => h.bossOrders.length > 0);
      } else {
        // Every later phase is reached by playing the run out with the player winning, which
        // is the only way to get past the Warden: `playUntil` kills whatever is on the field,
        // so the run walks itself from one phase to the next.
        const target = {
          'boss-active': 'BOSS_ACTIVE',
          'gunship-countdown': 'GUNSHIP_COUNTDOWN',
          'gunship-incoming': 'GUNSHIP_INCOMING',
          'gunship-active': 'GUNSHIP_ACTIVE',
        }[phase];
        playUntil(h, () => h.director.status.phase === target);
      }
      h.world.playerDead = true;
      const produced = step(h);
      expect(`${phase}:${h.director.status.phase}`).toBe(`${phase}:DEFEAT`);
      expect(h.director.status.outcome).toBe('defeat');
      expect(h.ended).toEqual(['defeat']);
      expect(produced).toHaveLength(0);
      expect(h.director.acceptsPending()).toBe(false);
    }
  });

  it('stops releasing anything after the defeat, even with the field cleared', () => {
    const h = harness();
    stepUntil(h, () => h.smallOrders.length > 0);
    h.world.playerDead = true;
    step(h);
    const announced = h.pending.length;

    for (let i = 0; i < 60 * 120; i += 1) {
      h.world.smallAlive = 0;
      h.world.bossAlive = false;
      expect(step(h)).toHaveLength(0);
    }
    expect(h.pending).toHaveLength(announced);
    expect(h.ended).toEqual(['defeat']);
  });

  it('reaches VICTORY only after both heavies have arrived and died, and only once', () => {
    const h = harness();
    playUntil(h, () => h.ended.length > 0);
    expect(h.ended).toEqual(['victory']);
    expect(h.director.status.phase).toBe('VICTORY');
    expect(h.director.status.outcome).toBe('victory');
    // Both bodies really were on the field: `bossArrived` / `gunshipArrived` are the flags
    // that separate "it was ordered" from "it was killed".
    expect(h.director.status.bossArrived).toBe(true);
    expect(h.director.status.gunshipArrived).toBe(true);
    expect(h.bossOrders).toHaveLength(1);
    expect(h.gunshipOrders).toHaveLength(1);

    for (let i = 0; i < 600; i += 1) step(h);
    expect(h.ended).toHaveLength(1);
    expect(step(h)).toHaveLength(0);
  });

  it('never reports victory while the Warden is still standing', () => {
    const h = harness();
    playUntil(h, () => h.director.status.phase === 'BOSS_ACTIVE');
    for (let i = 0; i < 60 * 120; i += 1) {
      // Set the body *before* the tick: the Warden is standing, and the run has to notice
      // that rather than the harness's post-tick edit of the previous frame.
      h.world.bossAlive = true;
      step(h);
      h.world.smallAlive = 0;
    }
    expect(h.ended).toHaveLength(0);
    expect(h.director.status.phase).toBe('BOSS_ACTIVE');
  });

  it('resets to a fresh countdown, and a fresh run draws the same points', () => {
    const h = harness();
    playUntil(h, () => h.smallOrders.length > 0);
    h.world.playerDead = true;
    step(h);
    expect(h.director.status.phase).toBe('DEFEAT');

    h.director.reset();
    h.world.playerDead = false;
    h.world.time = 0;
    expect(h.director.status.phase).toBe('OPENING');
    expect(h.director.status.outcome).toBe('running');
    expect(h.director.status.batch).toBe(1);
    expect(h.director.status.remaining).toBe(30);
    expect(h.director.status.spawnedSmall).toBe(0);
    expect(h.director.status.inFlightSmall).toBe(0);
    expect(h.director.status.bossPending).toBe(true);
    expect(h.director.status.bossReleased).toBe(false);
    expect(h.director.acceptsPending()).toBe(true);
    expect(h.director.status.countdownSeconds).toBeCloseTo(DIRECTOR.openingCountdown, 6);
    // The opening is announced again, which is what makes a restart show the countdown.
    const announcementsBefore = h.started.length;
    step(h);
    expect(h.started.length).toBe(announcementsBefore + 1);

    // Same seed, so the reset run has to reproduce a brand-new one draw for draw. The plan
    // no longer consumes the stream (the script is fixed), so what this pins is that the
    // *spawn points* still come from the reset stream rather than from wherever the last
    // run had got to.
    const fresh = harness();
    const resetStart = h.smallOrders.length;
    playUntil(h, () => h.smallOrders.length - resetStart >= 5);
    playUntil(fresh, () => fresh.smallOrders.length >= 5);
    const resetOrders = h.smallOrders.slice(resetStart, resetStart + 5);
    expect(resetOrders.map((order) => order.position)).toEqual(fresh.smallOrders.slice(0, 5).map((o) => o.position));
  });
});

describe('director: spawn orders', () => {
  it('gives every order a unique id and a positive warning', () => {
    const h = harness();
    stepUntil(h, () => h.smallOrders.length >= 15);
    const ids = new Set(h.smallOrders.map((order) => order.orderId));
    expect(ids.size).toBe(h.smallOrders.length);
    for (const order of h.smallOrders) {
      expect(order.warning).toBeGreaterThan(0);
      expect(Number.isFinite(order.position.x)).toBe(true);
      expect(Number.isFinite(order.position.z)).toBe(true);
    }
  });

  it('releases capacity when an order is confirmed, and is idempotent about it', () => {
    const h = harness();
    stepUntil(h, () => h.director.status.inFlightSmall > 0);
    const order = h.smallOrders[0];
    expect(order).toBeDefined();
    if (!order) return;
    const inFlight = h.director.status.inFlightSmall;
    expect(inFlight).toBe(5);

    h.director.confirmSpawn(order.orderId);
    expect(h.director.status.inFlightSmall).toBe(inFlight - 1);
    const spawned = h.director.status.spawnedSmall;
    // A second confirmation for the same order must change nothing, or a double delivery
    // would silently un-count a different order's body.
    h.director.confirmSpawn(order.orderId);
    expect(h.director.status.inFlightSmall).toBe(inFlight - 1);
    expect(h.director.status.spawnedSmall).toBe(spawned);
    // An unknown id is ignored too.
    h.director.confirmSpawn(999_999);
    expect(h.director.status.spawnedSmall).toBe(spawned);
  });

  it('releases capacity when an order is abandoned, without crediting a body', () => {
    const h = harness();
    stepUntil(h, () => h.director.status.inFlightSmall > 0);
    const order = h.smallOrders[0];
    expect(order).toBeDefined();
    if (!order) return;
    const inFlight = h.director.status.inFlightSmall;

    h.director.abandonSpawn(order.orderId);
    expect(h.director.status.inFlightSmall).toBe(inFlight - 1);
    expect(h.director.status.spawnedSmall).toBe(0);
    h.director.abandonSpawn(999_999);
    expect(h.director.status.inFlightSmall).toBe(inFlight - 1);
  });

  it('gives two seeds two different set of spawn points on one schedule', () => {
    const a = harness(1);
    const b = harness(2);
    stepUntil(a, () => a.smallOrders.length >= 5);
    stepUntil(b, () => b.smallOrders.length >= 5);
    // Same schedule...
    expect(dropTimes(a)).toEqual(dropTimes(b));
    expect(dropSizes(a)).toEqual(dropSizes(b));
    // ...different ground: the stream survives for exactly this.
    expect(a.smallOrders.map((order) => order.position)).not.toEqual(b.smallOrders.map((order) => order.position));
  });

  it('keeps the script when the tuning is changed between runs', () => {
    const saved = DIRECTOR_TUNING.batchSizes;
    try {
      const h = harness();
      stepUntil(h, () => h.smallOrders.length > 0);
      DIRECTOR_TUNING.batchSizes = [1];
      h.director.reset();
      h.world.time = 0;
      expect(h.director.status.plannedSmall).toBe(1);
      expect(h.director.status.totalBatches).toBe(1);
      stepUntil(h, () => h.smallOrders.length > 5);
      expect(h.director.status.phase).toBe('CLEARING');
    } finally {
      DIRECTOR_TUNING.batchSizes = saved;
    }
  });
});
