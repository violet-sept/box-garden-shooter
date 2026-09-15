/**
 * The performance scene (phase 4, task #0).
 *
 * ## Why this file has to exist
 *
 * Two of the phase-4 acceptance targets — "120 entities at 60 FPS" and "a simulation
 * tick at or under 2 ms" — could not be measured at all before this: the director's
 * concurrency cap is 18, and the phase-3 debug formation was deleted wholesale.
 * The instruments were already there (`LoopMetrics` computes `fps` / `tps` /
 * `stepMs` / `renderMs`, and the F3 panel displays them); what was missing was a
 * road that could reach 120 bodies.
 *
 * ## What this is, and what it is not
 *
 * It is a **measurement rig that lives outside the simulation**. It does not add a
 * branch to `World`, `Director` or any AI module: it calls the same public
 * `enemies.spawn` the director's orders end up calling, and it hands the world an
 * intent in place of the input layer. That keeps the phase-4 hard rule intact
 * ("do not add anything to the simulation layer") and keeps "who spawns enemies"
 * with exactly one answer during a normal run.
 *
 * Two things it does that a normal run would never do, both deliberate:
 *
 *   - It keeps the player topped up at full health and keeps the magazine full, so
 *     the scene can hold peak load for the whole measurement window. Without the
 *     first, the swarm kills the player in a few seconds and the run ends; without
 *     the second, the weapon runs dry after 30 rounds and "full fire rate" — half
 *     the point of the test — stops being true.
 *   - It sweeps the aim, so the shots actually cross the crowd. Firing into one
 *     fixed direction would leave the hit query and the damage path nearly idle.
 *
 * It is reachable **only** through `?scene=perf` (see `PERF.sceneName`), which is
 * what stops it from ever being on during a real run.
 */

import { PERF, PERF_SWEEP_PIXELS_PER_TICK, SIM, WEAPON } from '../core/config';
import type { InputIntent } from '../core/input';
import type { LoopMetrics } from '../core/loop';
import { createRng, type Rng } from '../core/math/rng';
import { DEG2RAD } from '../core/math/vec3';
import type { World } from '../game/World';

/** Everything the acceptance harness reports back. */
export interface PerfSnapshot {
  /** Bodies the scene aims to keep alive, from `PERF.entityCount`. */
  readonly entityCountTarget: number;
  /** Bodies actually alive when the snapshot was taken. */
  readonly entitiesAlive: number;
  readonly smallAlive: number;
  readonly largeAlive: number;
  /**
   * `EnemyStore.targets.length`, dummies included.
   *
   * The leak canary: this must plateau at the peak live count and never grow with
   * the number of kills, which is exactly the failure phase 2 shipped and fixed.
   */
  readonly storeEntries: number;
  readonly shotsFired: number;
  readonly kills: number;
  readonly ticks: number;
  readonly fps: number;
  readonly tps: number;
  readonly stepMs: number;
  readonly renderMs: number;
  readonly stepsLastFrame: number;
  readonly droppedStepFrames: number;
  readonly seed: number;
}

/** What the scene does for the composition root. */
export interface PerfScene {
  /**
   * Runs immediately before each simulation tick: restores the population, the
   * player's health and the magazine.
   */
  beforeTick(world: World): void;
  /** The intent the world is ticked with, in place of the input layer's. */
  intent(): InputIntent;
  /** A read-only reading of the load and the frame counters. */
  snapshot(world: World, metrics: LoopMetrics): PerfSnapshot;
}

/** Options for {@link createPerfScene}. Defaults are the tuning table. */
export interface PerfSceneOptions {
  readonly entityCount?: number;
  readonly ringRadius?: number;
  readonly seed?: number;
}

/**
 * Creates the scene.
 *
 * The placement is a seeded ring rather than `Math.random()`: two runs of the
 * measurement must be the same run, or two readings cannot be compared and "did
 * that change cost 1 ms" has no answer.
 */
export function createPerfScene(options: PerfSceneOptions = {}): PerfScene {
  const entityCount = options.entityCount ?? PERF.entityCount;
  const ringRadius = options.ringRadius ?? PERF.ringRadius;
  const seed = options.seed ?? PERF.seed;
  const rng: Rng = createRng(seed);

  /**
   * Scratch position, reused.
   *
   * `spawn` copies the values it needs, so one mutable object is enough — and the
   * whole point of the scene is that measuring it does not itself allocate.
   */
  const point = { x: 0, y: 0, z: 0 };
  /** Bodies are lifted slightly and staggered in height so they do not interpenetrate. */
  let spawned = 0;

  /**
   * The intent handed to the world.
   *
   * Mutable scratch behind a readonly interface, the same trick the composition root
   * uses for the idle intent: one object, written in place, never reallocated.
   */
  const intent: {
    -readonly [K in keyof InputIntent]: InputIntent[K];
  } = {
    move: { forward: 0, right: 0 },
    sprint: false,
    jump: false,
    fire: true,
    aim: false,
    reload: false,
    throwItem: false,
    // Never toggled: the acceptance run measures one view mode, and a scene that flipped
    // mid-measurement would compare two different frame costs under one number.
    toggleView: false,
    // A slow, constant turn: over the measurement window the aim sweeps a full
    // circle, so every part of the crowd takes fire in turn. Derived from the tick
    // rate and the look sensitivity so the sweep takes `PERF.sweepSeconds`.
    lookDeltaX: PERF_SWEEP_PIXELS_PER_TICK,
    lookDeltaY: 0,
  };

  /** Arena keep-out, so a rig body is never placed outside the playable box. */
  const limit = SIM.arenaHalfSize - 1.5;

  const placeNext = (playerX: number, playerZ: number): void => {
    // Golden-angle stepping gives an even ring without a lookup table, and the
    // seeded jitter keeps two consecutive runs from being pixel-identical.
    const angle = spawned * 2.399963 + rng.range(-0.08, 0.08);
    const radius = ringRadius + rng.range(-2, 2);
    point.x = clamp(playerX + Math.cos(angle) * radius, -limit, limit);
    point.y = 0;
    point.z = clamp(playerZ + Math.sin(angle) * radius, -limit, limit);
    spawned += 1;
  };

  const countAlive = (world: World): number => {
    // `liveCount()` and not a scan over `targets`: the store also holds the eight
    // practice dummies, and they are deliberately excluded from every count the game
    // reasons about. Counting them here would quietly field 112 combatants instead of
    // the 120 the brief names.
    return world.enemies.liveCount();
  };

  return {
    beforeTick(world) {
      const player = world.player;
      // Full health: the scene must survive its own load for the whole window.
      player.health = player.maxHealth;
      // Full magazine: 640 RPM empties 30 rounds in 2.8 s, and "and full fire rate"
      // is half of what the acceptance target names.
      player.weapon.magazine = WEAPON.magazineSize;
      // Hold the aim on the ring rather than over it. The scene spawns bodies on the floor and
      // the player's eye is above them, so a level sweep shoots the sky: see `PERF.sweepPitchDeg`.
      // Written every tick like the two above, and for the same reason — the scene owns these
      // three values for the whole window, so nothing else can drift them mid-measurement.
      player.pitch = PERF.sweepPitchDeg * DEG2RAD;

      let live = countAlive(world);
      let guard = 0;
      while (live < entityCount && guard < entityCount) {
        guard += 1;
        placeNext(player.position.x, player.position.z);
        world.enemies.spawn('small', point);
        live += 1;
      }
    },

    intent() {
      return intent;
    },

    snapshot(world, metrics) {
      const live = world.enemies.liveCount();
      return {
        entityCountTarget: entityCount,
        entitiesAlive: live,
        smallAlive: world.enemies.liveCount('small'),
        largeAlive: world.enemies.liveCount('large'),
        storeEntries: world.enemies.targets.length,
        shotsFired: world.stats.shotsFired,
        kills: world.stats.targetsKilled,
        ticks: world.stats.ticks,
        fps: metrics.fps,
        tps: metrics.tps,
        stepMs: metrics.stepMs,
        renderMs: metrics.renderMs,
        stepsLastFrame: metrics.stepsLastFrame,
        droppedStepFrames: metrics.droppedStepFrames,
        seed: world.seed,
      };
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
