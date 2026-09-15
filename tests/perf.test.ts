/**
 * Simulation performance test (phase 4).
 *
 * ## What this proves, and what it does not
 *
 * It proves an **upper bound on one simulation tick** at the brief's worst case: 120
 * bodies on the field with the weapon firing at its full 640 RPM. That is genuinely
 * useful — it is the one half of the frame budget that has no rendering in it, and
 * the simulation is where the O(n^2) candidates live (enemy separation, the shot
 * query over every entry).
 *
 * It is **not** evidence for "120 entities at 60 FPS". There is no GPU here, no draw
 * calls, no shadow pass and no compositor, and this runs on whatever machine CI
 * happens to use. The 60 FPS claim needs the real shell, which is what
 * `npm run desktop:accept -- --scene perf` is for. The phase-4 execution guide says
 * exactly this, and the distinction matters: an untested claim dressed up as a tested
 * one is how "performance is already handled" got written into the plan in the first
 * place.
 *
 * The test uses the real `createPerfScene`, so it also covers the rig the desktop
 * harness drives: if the scene stopped keeping 120 bodies alive, this would fail
 * before the acceptance run did.
 */

import { describe, expect, it } from 'vitest';
import { createWorld } from '#/game/World';
import { EventBus } from '#/core/events';
import { createPerfScene } from '#/debug/perfScene';
import { DIRECTOR, PERF, SIM } from '#/core/config';
import {
  readFlag,
  readQueryParam,
  readVolume,
  SETTING_KEYS,
  writeFlag,
  writeVolume,
} from '#/platform/Platform';

/**
 * Upper bound on the mean tick time, in milliseconds.
 *
 * Deliberately loose. The brief's target is 2 ms, but this runs on a shared CI box
 * with no GPU and with the JIT still warming up, so a 2 ms assertion here would be a
 * coin flip on unrelated load. Four times the target is still tight enough to catch
 * the failure that matters — an accidentally quadratic system, a per-tick allocation
 * storm, or a pool that stopped recycling — because those cost an order of magnitude,
 * not twenty percent.
 */
const MEAN_TICK_BUDGET_MS = 8;

/** Upper bound on any single tick, which is the one that causes a visible hitch. */
const WORST_TICK_BUDGET_MS = 40;

/** Ticks the measurement runs for, after a warm-up. */
const MEASURED_TICKS = 600;
const WARMUP_TICKS = 120;

/** Builds a world and drives the performance scene over it, timing each tick. */
function measure(tickCount: number): { samples: Float64Array; scene: ReturnType<typeof createPerfScene>; world: ReturnType<typeof createWorld> } {
  const world = createWorld({ events: new EventBus(), seed: PERF.seed });
  const scene = createPerfScene();
  const samples = new Float64Array(tickCount);
  const dt = 1 / SIM.tickHz;
  for (let tick = 0; tick < tickCount; tick += 1) {
    scene.beforeTick(world);
    const started = performance.now();
    world.tick(dt, scene.intent());
    samples[tick] = performance.now() - started;
  }
  return { samples, scene, world };
}

function stats(samples: Float64Array, from: number): { mean: number; worst: number } {
  let sum = 0;
  let worst = 0;
  let count = 0;
  for (let i = from; i < samples.length; i += 1) {
    const sample = samples[i] ?? 0;
    sum += sample;
    if (sample > worst) worst = sample;
    count += 1;
  }
  return { mean: count > 0 ? sum / count : 0, worst };
}

describe('simulation performance at the brief\'s worst case', () => {
  it('holds the configured body count while the weapon fires flat out', () => {
    const world = createWorld({ events: new EventBus(), seed: 7 });
    const scene = createPerfScene({ entityCount: 40 });
    for (let tick = 0; tick < 60; tick += 1) {
      scene.beforeTick(world);
      world.tick(1 / SIM.tickHz, scene.intent());
    }
    const snapshot = scene.snapshot(world, {
      fps: 0,
      tps: 0,
      stepMs: 0,
      renderMs: 0,
      stepsLastFrame: 1,
      droppedStepFrames: 0,
    });
    // A small count here so the assertion is about the rig's bookkeeping rather than
    // about the machine's speed.
    expect(snapshot.entitiesAlive).toBeGreaterThanOrEqual(40);
    expect(snapshot.entityCountTarget).toBe(40);
    expect(snapshot.shotsFired).toBeGreaterThan(0);
    expect(snapshot.storeEntries).toBeGreaterThanOrEqual(40);
  });

  it('keeps one tick inside the simulation budget at 120 entities', () => {
    measure(WARMUP_TICKS);
    const { samples } = measure(MEASURED_TICKS);
    const { mean, worst } = stats(samples, WARMUP_TICKS / 2);

    // Printed so the number can be quoted in the implementation notes instead of
    // being described as "fast enough".
    console.log(
      `[perf] 120 entities + full fire rate: mean tick ${mean.toFixed(3)} ms, worst ${worst.toFixed(3)} ms ` +
        `(target ${2} ms, CI budget ${MEAN_TICK_BUDGET_MS} ms)`,
    );

    expect(mean).toBeLessThan(MEAN_TICK_BUDGET_MS);
    expect(worst).toBeLessThan(WORST_TICK_BUDGET_MS);
  });

  it('does not grow the enemy store as bodies are killed and replaced', () => {
    const world = createWorld({ events: new EventBus(), seed: PERF.seed });
    const scene = createPerfScene();
    const dt = 1 / SIM.tickHz;

    let atHalf = 0;
    const total = 1800;
    for (let tick = 0; tick < total; tick += 1) {
      scene.beforeTick(world);
      world.tick(dt, scene.intent());
      if (tick === total / 2) atHalf = world.enemies.targets.length;
    }
    const atEnd = world.enemies.targets.length;

    // The steady state is the population plus the practice dummies plus whatever the
    // director has released on top.
    expect(atEnd).toBeLessThanOrEqual(PERF.entityCount + DIRECTOR.maxConcurrentTotal + 8);
    // The leak canary: a store that grew with the *kill count* would be far past this
    // by the second half of a thirty-second run.
    expect(atEnd).toBeLessThanOrEqual(atHalf + 4);
    // Kills are the churn the store has to survive; the exact rate depends on the
    // sweep, so this only asserts that kills really happened.
    expect(world.stats.targetsKilled).toBeGreaterThan(10);
    expect(world.stats.shotsFired).toBeGreaterThan(200);
  });

  it('never produces a NaN position, however long it runs', () => {
    const world = createWorld({ events: new EventBus(), seed: PERF.seed });
    const scene = createPerfScene();
    const dt = 1 / SIM.tickHz;
    for (let tick = 0; tick < 900; tick += 1) {
      scene.beforeTick(world);
      world.tick(dt, scene.intent());
    }
    expect(Number.isFinite(world.player.position.x)).toBe(true);
    expect(Number.isFinite(world.player.position.z)).toBe(true);
    for (const enemy of world.enemies.targets) {
      expect(Number.isFinite(enemy.position.x)).toBe(true);
      expect(Number.isFinite(enemy.position.y)).toBe(true);
      expect(Number.isFinite(enemy.position.z)).toBe(true);
      expect(Number.isFinite(enemy.velocity.x)).toBe(true);
    }
  });

  it('is deterministic for a fixed seed', () => {
    const runOnce = (): number[] => {
      const world = createWorld({ events: new EventBus(), seed: PERF.seed });
      const scene = createPerfScene();
      const dt = 1 / SIM.tickHz;
      for (let tick = 0; tick < 240; tick += 1) {
        scene.beforeTick(world);
        world.tick(dt, scene.intent());
      }
      return world.enemies.targets.map((enemy) => Number(enemy.position.x.toFixed(6)));
    };
    // The whole point of the scene's seeded ring: two perf runs must be the same run,
    // or two readings cannot be compared.
    expect(runOnce()).toEqual(runOnce());
  });
});

describe('performance scene gate', () => {
  /** Runs `body` with `globalThis.location` stubbed, then restores it. */
  function withLocation(search: string | undefined, body: () => void): void {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: search === undefined ? undefined : { search },
    });
    try {
      body();
    } finally {
      if (original) Object.defineProperty(globalThis, 'location', original);
      else Reflect.deleteProperty(globalThis, 'location');
    }
  }

  it('turns the scene on for `?scene=perf` and for nothing else', () => {
    const enabled = (search: string | undefined): boolean => {
      let result = false;
      withLocation(search, () => {
        result = readQueryParam('scene') === PERF.sceneName;
      });
      return result;
    };
    expect(enabled('?scene=perf')).toBe(true);
    expect(enabled('?foo=1&scene=perf')).toBe(true);
    expect(enabled('?scene=perf&foo=1')).toBe(true);
    // Not reachable by accident: a normal run, a different scene name, or a host with
    // no location at all must all leave the measurement rig switched off.
    expect(enabled('')).toBe(false);
    expect(enabled('?scene=perf2')).toBe(false);
    expect(enabled('?other=perf')).toBe(false);
    expect(enabled(undefined)).toBe(false);
  });

  it('round-trips the volume and mute settings through the storage layer', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } as unknown as Storage;
    const platform = { isDesktop: false, isTouchOnly: false, storage };

    writeVolume(platform, SETTING_KEYS.masterVolume, 0.42);
    expect(readVolume(platform, SETTING_KEYS.masterVolume, 0.7)).toBeCloseTo(0.42, 3);
    // Out-of-range and garbage values fall back rather than propagating into a gain.
    store.set(SETTING_KEYS.masterVolume, '7');
    expect(readVolume(platform, SETTING_KEYS.masterVolume, 0.7)).toBe(1);
    store.set(SETTING_KEYS.masterVolume, 'loud');
    expect(readVolume(platform, SETTING_KEYS.masterVolume, 0.7)).toBe(0.7);

    writeFlag(platform, SETTING_KEYS.muted, true);
    expect(readFlag(platform, SETTING_KEYS.muted, false)).toBe(true);
    writeFlag(platform, SETTING_KEYS.muted, false);
    expect(readFlag(platform, SETTING_KEYS.muted, true)).toBe(false);

    // A host that blocks storage must degrade to the defaults, never throw.
    const blocked = { isDesktop: false, isTouchOnly: false, storage: null };
    expect(() => writeVolume(blocked, SETTING_KEYS.masterVolume, 0.3)).not.toThrow();
    expect(readVolume(blocked, SETTING_KEYS.masterVolume, 0.7)).toBe(0.7);
  });
});
