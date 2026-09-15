/**
 * The wave director.
 *
 * `docs/阶段3.md` section 7 fixes the assertions, and the first three are the point of
 * the whole file: the large enemy is released when the small enemies are cleared,
 * when the timer expires, and **exactly once** when both are true at the same time.
 * That third case is why the director produces orders instead of spawning directly —
 * none of the three needs a world to test, which is what makes it practical to cover
 * the one that only ever happens in a real run.
 *
 * Everything here is plain data: a context is a struct literal, and the "world" is a
 * counter.
 */

import { describe, expect, it } from 'vitest';
import { DIRECTOR, DIRECTOR_TUNING, ENEMY_LARGE, ENEMY_SMALL } from '#/core/config';
import type { Vector3 } from '#/core/math/vec3';
import { createDirector, type Director, type SpawnCommand } from '#/game/director/Director';
import type { WavePlan } from '#/game/director/waves';

const DT = 1 / 60;
const PLAYER: Vector3 = { x: 0, y: 0, z: 8 };

interface Recorder {
  readonly director: Director;
  readonly wavesStarted: WavePlan[];
  readonly wavesCleared: WavePlan[];
  readonly bossSpawns: { reason: 'cleared' | 'timeout'; order: SpawnCommand }[];
  readonly spawnPendings: { command: SpawnCommand; archetype: string }[];
  readonly runsEnded: string[];
  /** Every small order ever issued, so a test can count them. */
  readonly smallOrders: SpawnCommand[];
  readonly bossOrders: SpawnCommand[];
}

function makeDirector(seed = 5): Recorder {
  const wavesStarted: WavePlan[] = [];
  const wavesCleared: WavePlan[] = [];
  const bossSpawns: { reason: 'cleared' | 'timeout'; order: SpawnCommand }[] = [];
  const spawnPendings: { command: SpawnCommand; archetype: string }[] = [];
  const runsEnded: string[] = [];
  const smallOrders: SpawnCommand[] = [];
  const bossOrders: SpawnCommand[] = [];

  const director = createDirector({
    seed,
    events: {
      waveStarted(plan) {
        wavesStarted.push(plan);
      },
      waveCleared(plan) {
        wavesCleared.push(plan);
      },
      bossSpawned(order, reason) {
        bossSpawns.push({ reason, order });
      },
      spawnPending(command, archetype) {
        spawnPendings.push({ command, archetype });
        if (command.boss) bossOrders.push(command);
        else smallOrders.push(command);
      },
      runEnded(outcome) {
        runsEnded.push(outcome);
      },
    },
  });

  return { director, wavesStarted, wavesCleared, bossSpawns, spawnPendings, runsEnded, smallOrders, bossOrders };
}

/** The world state the director reads, and the only thing a test has to fake. */
interface FakeWorld {
  smallAlive: number;
  bossAlive: boolean;
  playerDead: boolean;
}

/** The director's per-tick view of the fake world. */
function contextFor(world: FakeWorld, dt: number) {
  return {
    tick: 0,
    time: 0,
    dt,
    playerPosition: PLAYER,
    playerYaw: 0,
    playerDead: world.playerDead,
    smallAlive: world.smallAlive,
    bossAlive: world.bossAlive,
  };
}

/** One tick, modelling a world where every order lands. */
function step(recorder: Recorder, world: FakeWorld, dt = DT): SpawnCommand[] {
  const produced: SpawnCommand[] = [];
  recorder.director.tick(contextFor(world, dt), produced);
  for (const order of produced) {
    recorder.director.confirmSpawn(order.orderId);
    if (order.boss) world.bossAlive = true;
    else world.smallAlive += 1;
  }
  return produced;
}

/**
 * One tick, then the player finishes whatever is on the field.
 *
 * The killing lands *after* the director has seen the tick, which is what a real
 * player does: they react to what is in front of them. Clearing the field before the
 * tick instead would let the director skip its own release cadence, and a test built
 * on that would never exercise the timing it is meant to be checking.
 */
function stepVictorious(recorder: Recorder, world: FakeWorld, dt = DT): SpawnCommand[] {
  const produced = step(recorder, world, dt);
  world.smallAlive = 0;
  world.bossAlive = false;
  return produced;
}

/** One tick with the order never fulfilled: the body is still in its warning. */
function stepUnconfirmed(recorder: Recorder, world: FakeWorld, dt = DT): SpawnCommand[] {
  const produced: SpawnCommand[] = [];
  recorder.director.tick(contextFor(world, dt), produced);
  return produced;
}

/** Runs ticks until `done`, or fails with the phase it got stuck in. */
function stepUntil(recorder: Recorder, world: FakeWorld, done: () => boolean, limit = 20_000): void {
  for (let i = 0; i < limit; i += 1) {
    step(recorder, world);
    if (done()) return;
  }
  throw new Error(`condition never met; phase is ${recorder.director.status.phase}`);
}

/** Advances through the opening grace period without any wave starting. */
function skipOpening(recorder: Recorder, world: FakeWorld): void {
  if (recorder.director.status.phase !== 'OPENING') return;
  stepUntil(recorder, world, () => recorder.director.status.phase !== 'OPENING');
}

/**
 * Plays the run forward, clearing the field every tick, until `phase` is reached.
 *
 * `stepVictorious` is what a player who wins every fight does, so this is the "play
 * the run out" helper. It targets a phase rather than "anything changed", because a
 * wave passes through several phases on the way to the intermission.
 */
function playUntilPhase(recorder: Recorder, world: FakeWorld, phase: string): void {
  const limit = 60 * 60 * 30;
  for (let i = 0; i < limit; i += 1) {
    stepVictorious(recorder, world);
    if (recorder.director.status.phase === phase) return;
  }
  throw new Error(`the phase never became ${phase}`);
}

describe('director: the opening', () => {
  it('holds fire for the configured grace period, then starts wave one', () => {
    const recorder = makeDirector();
    const world: FakeWorld = { smallAlive: 0, bossAlive: false, playerDead: false };
    expect(recorder.director.status.phase).toBe('OPENING');

    // Just short of the grace period: still nothing.
    const ticks = Math.floor(DIRECTOR.openingGracePeriod / DT) - 2;
    for (let i = 0; i < ticks; i += 1) {
      expect(step(recorder, world).length).toBe(0);
    }
    expect(recorder.wavesStarted.length).toBe(0);

    stepUntil(recorder, world, () => recorder.wavesStarted.length > 0);
    expect(recorder.wavesStarted[0]?.wave).toBe(0);
    expect(recorder.director.status.wave).toBe(1);
  });

  it('reports the first wave as wave 1, not wave 0', () => {
    const recorder = makeDirector();
    const world: FakeWorld = { smallAlive: 0, bossAlive: false, playerDead: false };
    skipOpening(recorder, world);
    expect(recorder.director.status.wave).toBe(1);
    expect(recorder.director.status.waveIndex).toBe(0);
    expect(recorder.director.status.totalWaves).toBe(DIRECTOR.totalWaves);
  });
});

describe('director: releasing small enemies', () => {
  it('releases them one at a time rather than in a batch', () => {
    const recorder = makeDirector();
    const world: FakeWorld = { smallAlive: 0, bossAlive: false, playerDead: false };
    skipOpening(recorder, world);
    // Wave one releases six over ~4 s, so any single tick carries at most one.
    for (let i = 0; i < 60; i += 1) {
      expect(step(recorder, world).length).toBeLessThanOrEqual(1);
    }
    expect(recorder.smallOrders.length).toBeGreaterThan(1);
  });

  it('releases exactly the wave plan count before locking the boss', () => {
    const recorder = makeDirector();
    const world: FakeWorld = { smallAlive: 0, bossAlive: false, playerDead: false };
    skipOpening(recorder, world);
    const plan = recorder.wavesStarted[0]!;
    stepUntil(recorder, world, () => recorder.director.status.phase === 'BOSS_LOCKED');
    expect(recorder.smallOrders.length).toBe(plan.smallCount);
    expect(recorder.director.status.plannedSmall).toBe(plan.smallCount);
    expect(recorder.bossSpawns.length).toBe(0);
  });

  it('stops releasing once the wave allotment is out', () => {
    const recorder = makeDirector();
    const world: FakeWorld = { smallAlive: 0, bossAlive: false, playerDead: false };
    skipOpening(recorder, world);
    const planned = recorder.wavesStarted[0]!.smallCount;
    stepUntil(recorder, world, () => recorder.director.status.phase === 'BOSS_LOCKED');
    for (let i = 0; i < 120; i += 1) step(recorder, world);
    expect(recorder.smallOrders.length).toBe(planned);
  });

  it('counts unfulfilled orders against the concurrency cap', () => {
    // The worst case, and the reason the in-flight count exists: bodies are still in
    // their warning and nothing is dying. A director that only looked at `smallAlive`
    // would issue the whole wave and blow straight through the cap.
    const recorder = makeDirector();
    const world: FakeWorld = { smallAlive: 0, bossAlive: false, playerDead: false };
    skipOpening(recorder, world);
    const planned = recorder.director.status.plannedSmall;
    for (let i = 0; i < 4000; i += 1) {
      stepUnconfirmed(recorder, world);
      const status = recorder.director.status;
      expect(world.smallAlive + status.inFlightSmall).toBeLessThanOrEqual(DIRECTOR.maxConcurrentSmall);
      expect(status.inFlightSmall).toBeLessThanOrEqual(DIRECTOR.maxConcurrentSmall);
    }
    // It kept issuing until either the wave's allotment was out or the cap was reached,
    // whichever came first — the smaller of the two, never the larger.
    expect(recorder.smallOrders.length).toBe(Math.min(planned, DIRECTOR.maxConcurrentSmall));
    expect(recorder.smallOrders.length).toBeGreaterThan(0);
  });

  it('holds the cap even when the wave plans more enemies than may be alive at once', () => {
    // A late wave plans well over the cap, which is the case the cap actually exists
    // for. Played at that wave with nothing ever dying, the in-flight count has to stop
    // the release rather than letting the whole allotment through.
    const saved = DIRECTOR_TUNING.totalWaves;
    DIRECTOR_TUNING.totalWaves = 30;
    try {
      const recorder = makeDirector(31);
      const world: FakeWorld = { smallAlive: 0, bossAlive: false, playerDead: false };
      // Walk to a wave whose plan exceeds the cap.
      let guard = 0;
      while (recorder.director.status.plannedSmall <= DIRECTOR.maxConcurrentSmall && guard < 60 * 60 * 40) {
        guard += 1;
        stepVictorious(recorder, world);
      }
      expect(recorder.director.status.plannedSmall).toBeGreaterThan(DIRECTOR.maxConcurrentSmall);

      // Now let the field fill and never clear it again.
      let peakInFlight = 0;
      let peakAlive = 0;
      for (let i = 0; i < 3000; i += 1) {
        step(recorder, world);
        peakInFlight = Math.max(peakInFlight, recorder.director.status.inFlightSmall);
        peakAlive = Math.max(peakAlive, world.smallAlive);
      }
      expect(peakAlive).toBeGreaterThan(0);
      expect(peakAlive).toBeLessThanOrEqual(DIRECTOR.maxConcurrentSmall);
      expect(peakInFlight).toBeLessThanOrEqual(DIRECTOR.maxConcurrentSmall);
      expect(peakAlive + recorder.director.status.inFlightSmall).toBeLessThanOrEqual(DIRECTOR.maxConcurrentSmall);
      // And it did not simply stall: the cap was actually reached.
      expect(peakAlive + peakInFlight).toBe(DIRECTOR.maxConcurrentSmall);
    } finally {
      DIRECTOR_TUNING.totalWaves = saved;
    }
  });

  it('never has more live small enemies than the cap allows when bodies do appear', () => {
    const recorder = makeDirector();
    const world: FakeWorld = { smallAlive: 0, bossAlive: false, playerDead: false };
    skipOpening(recorder, world);
    // Never kill anything: the swarm arrives and stays.
    for (let i = 0; i < 4000; i += 1) {
      step(recorder, world);
      expect(world.smallAlive).toBeLessThanOrEqual(DIRECTOR.maxConcurrentSmall);
      expect(world.smallAlive + recorder.director.status.inFlightSmall).toBeLessThanOrEqual(
        DIRECTOR.maxConcurrentSmall,
      );
    }
    expect(world.smallAlive).toBeGreaterThan(0);
  });
});

describe('director: the two unlock criteria', () => {
  it('releases the large enemy when the small enemies are cleared', () => {
    const recorder = makeDirector();
    const world: FakeWorld = { smallAlive: 0, bossAlive: false, playerDead: false };
    skipOpening(recorder, world);
    stepUntil(recorder, world, () => recorder.director.status.phase === 'BOSS_LOCKED');

    world.smallAlive = 0;
    stepUntil(recorder, world, () => recorder.bossSpawns.length > 0);

    expect(recorder.bossSpawns[0]?.reason).toBe('cleared');
    expect(recorder.bossSpawns[0]?.order.boss).toBe(true);
    expect(recorder.director.status.phase).toBe('BOSS_ACTIVE');
    expect(recorder.director.status.unlockReason).toBe('cleared');
  });

  it('releases the large enemy when the boss timer expires with smalls still alive', () => {
    const recorder = makeDirector();
    const world: FakeWorld = { smallAlive: 0, bossAlive: false, playerDead: false };
    skipOpening(recorder, world);
    stepUntil(recorder, world, () => recorder.director.status.phase === 'BOSS_LOCKED');

    // The timer starts at the wave's own threshold. Keep enemies alive for ever so
    // criterion (A) can never fire.
    expect(recorder.director.status.timer).toBeCloseTo(recorder.wavesStarted[0]!.bossTimer, 6);

    stepUntil(recorder, world, () => recorder.bossSpawns.length > 0, 60 * 200);
    expect(recorder.bossSpawns[0]?.reason).toBe('timeout');
    expect(world.smallAlive).toBeGreaterThan(0);
    expect(recorder.director.status.phase).toBe('BOSS_ACTIVE');
  });

  it('releases exactly one large enemy when both criteria fire on the same tick', () => {
    const recorder = makeDirector();
    const world: FakeWorld = { smallAlive: 0, bossAlive: false, playerDead: false };
    skipOpening(recorder, world);
    stepUntil(recorder, world, () => recorder.director.status.phase === 'BOSS_LOCKED');

    // Run the clock down to the last tick, then clear the field on the tick the timer
    // expires. This is the case the "one event with a reason" design exists for: two
    // locks, one large enemy.
    const ticks = Math.ceil(recorder.director.status.timer / DT);
    for (let i = 0; i < ticks; i += 1) step(recorder, world);
    world.smallAlive = 0;
    step(recorder, world);
    step(recorder, world);
    step(recorder, world);

    expect(recorder.bossSpawns.length).toBe(1);
    expect(recorder.bossOrders.length).toBe(1);
  });

  it('publishes one boss order per wave, whatever the reason', () => {
    for (const mode of ['cleared', 'timeout'] as const) {
      const recorder = makeDirector();
      const world: FakeWorld = { smallAlive: 0, bossAlive: false, playerDead: false };
      skipOpening(recorder, world);
      stepUntil(recorder, world, () => recorder.director.status.phase === 'BOSS_LOCKED');
      if (mode === 'cleared') world.smallAlive = 0;
      stepUntil(recorder, world, () => recorder.bossSpawns.length > 0, 60 * 200);
      expect(recorder.bossSpawns.length).toBe(1);
      expect(recorder.bossSpawns[0]?.reason).toBe(mode);
    }
  });
});

describe('director: while the large enemy is alive', () => {
  it('keeps trickling small enemies in', () => {
    const recorder = makeDirector();
    const world: FakeWorld = { smallAlive: 0, bossAlive: false, playerDead: false };
    skipOpening(recorder, world);
    world.smallAlive = 0;
    stepUntil(recorder, world, () => recorder.bossSpawns.length > 0);
    const before = recorder.smallOrders.length;

    // Kill everything repeatedly so only the trickle moves the count.
    for (let i = 0; i < 60 * 30; i += 1) {
      world.smallAlive = 0;
      step(recorder, world);
      if (recorder.smallOrders.length > before) break;
    }
    expect(recorder.smallOrders.length).toBeGreaterThan(before);
  });

  it('does not advance the wave while the large enemy lives', () => {
    const recorder = makeDirector();
    const world: FakeWorld = { smallAlive: 0, bossAlive: false, playerDead: false };
    skipOpening(recorder, world);
    world.smallAlive = 0;
    stepUntil(recorder, world, () => recorder.bossSpawns.length > 0);

    // The large enemy stays up for a full minute with the field otherwise empty: the
    // wave must not close, or "kill the Warden" would not be what ends it.
    for (let i = 0; i < 60 * 60; i += 1) {
      world.smallAlive = 0;
      world.bossAlive = true;
      step(recorder, world);
    }
    expect(recorder.wavesCleared.length).toBe(0);
    expect(recorder.director.status.waveIndex).toBe(0);
    expect(recorder.director.status.phase).toBe('BOSS_ACTIVE');
  });
});

describe('director: clearing a wave', () => {
  it('waits for the small enemies even after the large one is dead', () => {
    const recorder = makeDirector();
    const world: FakeWorld = { smallAlive: 0, bossAlive: false, playerDead: false };
    skipOpening(recorder, world);
    stepUntil(recorder, world, () => recorder.director.status.phase === 'BOSS_LOCKED');
    // The timeout path, so small enemies are guaranteed to still be alive.
    stepUntil(recorder, world, () => recorder.bossSpawns.length > 0, 60 * 200);
    expect(world.smallAlive).toBeGreaterThan(0);

    world.bossAlive = false;
    step(recorder, world);
    expect(recorder.wavesCleared.length).toBe(0);

    world.smallAlive = 0;
    step(recorder, world);
    expect(recorder.wavesCleared.length).toBe(1);
    expect(recorder.director.status.phase).toBe('INTERMISSION');
  });

  it('clears immediately when the large enemy dies on an empty field', () => {
    const recorder = makeDirector();
    const world: FakeWorld = { smallAlive: 0, bossAlive: false, playerDead: false };
    skipOpening(recorder, world);
    world.smallAlive = 0;
    stepUntil(recorder, world, () => recorder.bossSpawns.length > 0);
    // Empty the field as well as killing the large enemy: this is the "cleared" path,
    // not the "kill the Warden last" path, so both conditions have to hold at once.
    world.smallAlive = 0;
    world.bossAlive = false;
    step(recorder, world);
    expect(recorder.wavesCleared.length).toBe(1);
  });

  it('advances to the next wave after the intermission', () => {
    const recorder = makeDirector();
    const world: FakeWorld = { smallAlive: 0, bossAlive: false, playerDead: false };
    skipOpening(recorder, world);
    playUntilPhase(recorder, world, 'INTERMISSION');
    expect(recorder.wavesCleared.length).toBe(1);

    stepUntil(recorder, world, () => recorder.wavesStarted.length >= 2, 60 * 120);
    expect(recorder.wavesStarted[1]?.wave).toBe(1);
    expect(recorder.director.status.wave).toBe(2);
  });

  it('gives the intermission a real pause before the next wave', () => {
    const recorder = makeDirector();
    const world: FakeWorld = { smallAlive: 0, bossAlive: false, playerDead: false };
    skipOpening(recorder, world);
    playUntilPhase(recorder, world, 'INTERMISSION');
    expect(recorder.director.status.timer).toBeGreaterThanOrEqual(DIRECTOR.interWaveDelay);

    let quietTicks = 0;
    while (recorder.wavesStarted.length < 2) {
      expect(step(recorder, world).length).toBe(0);
      quietTicks += 1;
      if (quietTicks > 60 * 120) throw new Error('the intermission never ended');
    }
    expect(quietTicks / 60).toBeGreaterThanOrEqual(DIRECTOR.interWaveDelay - 1);
  });

  it('releases no large enemy on a breathing wave', () => {
    // Play the run until the first breathing wave has been started *and* cleared, then
    // check that no large enemy was ordered for it. This is what makes a breathing
    // wave a lull rather than a shorter ordinary one.
    const recorder = makeDirector();
    const world: FakeWorld = { smallAlive: 0, bossAlive: false, playerDead: false };
    const limit = 60 * 60 * 60;
    for (let i = 0; i < limit; i += 1) {
      stepVictorious(recorder, world);
      if (recorder.wavesCleared.some((plan) => plan.breathing)) break;
    }

    const breathing = recorder.wavesStarted.find((plan) => plan.breathing);
    expect(breathing).toBeDefined();
    const clearedBreathing = recorder.wavesCleared.find((plan) => plan.breathing);
    expect(clearedBreathing).toBeDefined();
    if (!breathing) return;

    // The large enemy had been released on the two ordinary waves before it...
    expect(recorder.bossOrders.length).toBe(recorder.wavesCleared.filter((plan) => !plan.breathing).length);
    // ...and the breathing wave added none.
    expect(recorder.bossSpawns.some((entry) => entry.order.boss && recorder.wavesCleared.indexOf(breathing) >= 0)).toBe(
      true,
    );
    expect(recorder.bossOrders.length).toBe(2);
    expect(recorder.wavesCleared.map((plan) => plan.breathing)).toEqual([false, false, true]);
  });
});

describe('director: ending the run', () => {
  it('enters DEFEAT when the player dies, from any phase', () => {
    const preparations = [
      (recorder: Recorder, world: FakeWorld) => {
        void recorder;
        void world;
      },
      (recorder: Recorder, world: FakeWorld) => skipOpening(recorder, world),
      (recorder: Recorder, world: FakeWorld) => {
        skipOpening(recorder, world);
        stepUntil(recorder, world, () => recorder.smallOrders.length > 2);
      },
    ];
    for (const prepare of preparations) {
      const recorder = makeDirector();
      const world: FakeWorld = { smallAlive: 0, bossAlive: false, playerDead: false };
      prepare(recorder, world);
      world.playerDead = true;
      const produced = step(recorder, world);
      expect(recorder.director.status.phase).toBe('DEFEAT');
      expect(recorder.director.status.outcome).toBe('defeat');
      expect(recorder.runsEnded).toEqual(['defeat']);
      expect(produced.length).toBe(0);
    }
  });

  it('stops releasing anything after the defeat, even with the field cleared', () => {
    const recorder = makeDirector();
    const world: FakeWorld = { smallAlive: 0, bossAlive: false, playerDead: false };
    skipOpening(recorder, world);
    world.playerDead = true;
    step(recorder, world);
    const ordersAtDeath = recorder.smallOrders.length;

    for (let i = 0; i < 60 * 120; i += 1) {
      world.smallAlive = 0;
      world.bossAlive = false;
      expect(step(recorder, world).length).toBe(0);
    }
    expect(recorder.smallOrders.length).toBe(ordersAtDeath);
    expect(recorder.runsEnded.length).toBe(1);
    expect(recorder.director.acceptsPending()).toBe(false);
  });

  it('enters VICTORY once the final wave is cleared, and only once', () => {
    const saved = DIRECTOR_TUNING.totalWaves;
    // A two-wave run: the shape of the ending is what is under test, not the length.
    DIRECTOR_TUNING.totalWaves = 2;
    try {
      const recorder = makeDirector(11);
      const world: FakeWorld = { smallAlive: 0, bossAlive: false, playerDead: false };
      let guard = 0;
      while (recorder.runsEnded.length === 0 && guard < 60 * 60 * 30) {
        guard += 1;
        stepVictorious(recorder, world);
      }
      expect(recorder.runsEnded).toEqual(['victory']);
      expect(recorder.director.status.phase).toBe('VICTORY');
      expect(recorder.director.status.outcome).toBe('victory');
      expect(recorder.wavesCleared.length).toBe(2);

      // And it stays there: no second event, no more orders.
      for (let i = 0; i < 600; i += 1) step(recorder, world);
      expect(recorder.runsEnded.length).toBe(1);
      expect(step(recorder, world).length).toBe(0);
    } finally {
      DIRECTOR_TUNING.totalWaves = saved;
    }
  });

  it('never reports victory before the final wave', () => {
    const saved = DIRECTOR_TUNING.totalWaves;
    DIRECTOR_TUNING.totalWaves = 3;
    try {
      const recorder = makeDirector(3);
      const world: FakeWorld = { smallAlive: 0, bossAlive: false, playerDead: false };
      let guard = 0;
      while (recorder.wavesCleared.length < 2 && guard < 60 * 60 * 40) {
        guard += 1;
        stepVictorious(recorder, world);
      }
      expect(recorder.wavesCleared.length).toBe(2);
      expect(recorder.runsEnded.length).toBe(0);
      expect(recorder.director.status.outcome).toBe('running');
    } finally {
      DIRECTOR_TUNING.totalWaves = saved;
    }
  });

  it('resets back to a fresh opening with a fresh stream', () => {
    const recorder = makeDirector();
    const world: FakeWorld = { smallAlive: 0, bossAlive: false, playerDead: false };
    skipOpening(recorder, world);
    stepUntil(recorder, world, () => recorder.smallOrders.length > 0);
    world.playerDead = true;
    step(recorder, world);
    expect(recorder.director.status.phase).toBe('DEFEAT');

    recorder.director.reset();
    world.playerDead = false;
    expect(recorder.director.status.phase).toBe('OPENING');
    expect(recorder.director.status.outcome).toBe('running');
    expect(recorder.director.status.wave).toBe(1);
    expect(recorder.director.status.spawnedSmall).toBe(0);
    expect(recorder.director.status.inFlightSmall).toBe(0);
    expect(recorder.director.acceptsPending()).toBe(true);

    // Same seed, so the reset run has to match a brand-new one exactly.
    //
    // Counted from the reset, not from birth: the recorder already ran part of a wave
    // before it died, and those orders are still in the list. What is under test is
    // that the *reset* run reproduces the fresh run draw for draw — a director that
    // planned a wave at construction *and* on entry would consume the jitter draw
    // twice and silently give a different second run.
    const fresh = makeDirector();
    const freshWorld: FakeWorld = { smallAlive: 0, bossAlive: false, playerDead: false };
    skipOpening(recorder, world);
    const resetStart = recorder.smallOrders.length;
    skipOpening(fresh, freshWorld);
    stepUntil(recorder, world, () => recorder.director.status.phase === 'BOSS_LOCKED', 60 * 60);
    stepUntil(fresh, freshWorld, () => fresh.director.status.phase === 'BOSS_LOCKED', 60 * 60);
    const resetOrders = recorder.smallOrders.slice(resetStart);
    expect(resetOrders.length).toBe(fresh.smallOrders.length);
    expect(resetOrders.map((order) => order.position)).toEqual(fresh.smallOrders.map((order) => order.position));
  });
});

describe('director: spawn orders', () => {
  it('gives every order a unique id and a positive warning', () => {
    const recorder = makeDirector();
    const world: FakeWorld = { smallAlive: 0, bossAlive: false, playerDead: false };
    skipOpening(recorder, world);
    stepUntil(recorder, world, () => recorder.smallOrders.length >= 3);
    const ids = new Set(recorder.smallOrders.map((order) => order.orderId));
    expect(ids.size).toBe(recorder.smallOrders.length);
    for (const order of recorder.smallOrders) {
      expect(order.warning).toBeGreaterThan(0);
      expect(order.healthScale).toBeGreaterThan(0);
      expect(Number.isFinite(order.position.x)).toBe(true);
      expect(Number.isFinite(order.position.z)).toBe(true);
    }
  });

  it('applies the wave health scale to the orders', () => {
    const recorder = makeDirector();
    const world: FakeWorld = { smallAlive: 0, bossAlive: false, playerDead: false };
    skipOpening(recorder, world);
    stepUntil(recorder, world, () => recorder.smallOrders.length > 0);
    expect(recorder.smallOrders[0]?.healthScale).toBeCloseTo(recorder.wavesStarted[0]!.healthScale, 10);
    // Wave one is unscaled: the first wave is the baseline the tuning is written
    // against, so a change there is a change to every balance number at once.
    expect(recorder.smallOrders[0]?.healthScale).toBeCloseTo(1, 10);
  });

  it('scales the health the wave actually means, relative to the archetype', () => {
    const recorder = makeDirector();
    const world: FakeWorld = { smallAlive: 0, bossAlive: false, playerDead: false };
    let guard = 0;
    while (recorder.wavesStarted.length < 2 && guard < 60 * 60 * 30) {
      guard += 1;
      stepVictorious(recorder, world);
    }
    expect(recorder.wavesStarted.length).toBeGreaterThanOrEqual(2);
    const second = recorder.wavesStarted[1]!;
    const scaled = ENEMY_SMALL.maxHealth * second.healthScale;
    expect(scaled).toBeGreaterThan(ENEMY_SMALL.maxHealth);
    expect(scaled).toBeLessThan(ENEMY_LARGE.maxHealth);
  });

  it('releases capacity when an order is confirmed, and is idempotent about it', () => {
    const recorder = makeDirector();
    const world: FakeWorld = { smallAlive: 0, bossAlive: false, playerDead: false };
    skipOpening(recorder, world);
    stepUnconfirmed(recorder, world);
    const order = recorder.smallOrders[0];
    expect(order).toBeDefined();
    if (!order) return;
    expect(recorder.director.status.inFlightSmall).toBe(1);

    recorder.director.confirmSpawn(order.orderId);
    expect(recorder.director.status.inFlightSmall).toBe(0);
    expect(recorder.director.status.spawnedSmall).toBe(1);
    // A second confirmation for the same order must change nothing, or a double
    // delivery would silently un-count a different order's body.
    recorder.director.confirmSpawn(order.orderId);
    expect(recorder.director.status.inFlightSmall).toBe(0);
    expect(recorder.director.status.spawnedSmall).toBe(1);
    // An unknown id is ignored too.
    recorder.director.confirmSpawn(999_999);
    expect(recorder.director.status.spawnedSmall).toBe(1);
  });

  it('releases capacity when an order is abandoned, without crediting a body', () => {
    const recorder = makeDirector();
    const world: FakeWorld = { smallAlive: 0, bossAlive: false, playerDead: false };
    skipOpening(recorder, world);
    stepUnconfirmed(recorder, world);
    const order = recorder.smallOrders[0];
    expect(order).toBeDefined();
    if (!order) return;

    recorder.director.abandonSpawn(order.orderId);
    expect(recorder.director.status.inFlightSmall).toBe(0);
    expect(recorder.director.status.spawnedSmall).toBe(0);
    recorder.director.abandonSpawn(999_999);
    expect(recorder.director.status.inFlightSmall).toBe(0);
  });
});
