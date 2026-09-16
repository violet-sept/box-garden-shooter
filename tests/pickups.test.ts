/**
 * Supply crates: the ammo box and the medkit (phase 11).
 *
 * Two layers, deliberately tested separately:
 *
 *   1. **The refresh rules**, against `createPickupSystem` alone — the twenty-second beat, one
 *      of each kind per beat, the cap of two per kind, "at the cap skip this beat and resume
 *      on a later one", and the placement rules (in the arena, not inside level geometry, not
 *      inside the player, not on top of another crate). No world, no renderer.
 *   2. **The interaction**, against a real `World` — `E` grants the right amount to the right
 *      pool, the crate is gone afterwards, and the amount the event reports is the amount that
 *      actually landed (a medkit at full health grants nothing and still gets spent).
 *
 * The four sentences of the brief are the whole feature, so they are the four groups of
 * assertions rather than a description of the code.
 */

import { describe, expect, it } from 'vitest';
import { PICKUPS, PLAYER, SIM, WEAPON } from '#/core/config';
import { EventBus } from '#/core/events';
import type { InputIntent } from '#/core/input';
import { buildLevel } from '#/game/level';
import type { CollisionWorld } from '#/game/player/player';
import {
  createPickupSystem,
  PICKUP_KINDS,
  type Pickup,
  type PickupSpawnContext,
  type PickupSystem,
} from '#/game/pickups/pickupSystem';
import { createWorld, type World } from '#/game/World';

const DT = 1 / SIM.tickHz;

/** A blank intent, so each test only states what it changes. */
function intent(overrides: Partial<InputIntent> = {}): InputIntent {
  return {
    move: { forward: 0, right: 0 },
    sprint: false,
    jump: false,
    fire: false,
    aim: false,
    reload: false,
    throwItem: false,
    interact: false,
    toggleView: false,
    lookDeltaX: 0,
    lookDeltaY: 0,
    ...overrides,
  };
}

/** The real level, so "not inside geometry" is decided against the shipped arena. */
function realObstacles(): CollisionWorld {
  const level = buildLevel();
  return { obstacles: level.collisionBoxes, solids: level.blockers, halfSize: level.halfSize };
}

function spawnContext(playerX = 0, playerZ = 8): PickupSpawnContext {
  return {
    playerPosition: { x: playerX, y: 0, z: playerZ },
    obstacles: realObstacles().obstacles,
    halfSize: SIM.arenaHalfSize,
  };
}

/** Advances `seconds` of refresh clock, collecting every crate that appears. */
function refreshFor(system: PickupSystem, seconds: number, context: PickupSpawnContext): Pickup[] {
  const produced: Pickup[] = [];
  const ticks = Math.round(seconds * SIM.tickHz);
  const batch: Pickup[] = [];
  for (let i = 0; i < ticks; i += 1) {
    batch.length = 0;
    system.tick(DT, context, batch);
    produced.push(...batch);
  }
  return produced;
}

/** Live crates, both kinds. */
function liveCrates(system: PickupSystem): Pickup[] {
  return system.pickups.filter((crate) => crate.active);
}

/** Whether two crates overlap, using the same cube the placement rule rejects on. */
function overlaps(a: Pickup, b: Pickup): boolean {
  const half = PICKUPS.size * 0.5;
  return (
    Math.abs(a.position.x - b.position.x) < half * 2 &&
    Math.abs(a.position.y - b.position.y) < half * 2 &&
    Math.abs(a.position.z - b.position.z) < half * 2
  );
}

describe('supply crates: the refresh beat', () => {
  it('delivers one of each kind on the run’s first tick, and the next pair one interval later', () => {
    const system = createPickupSystem({ seed: 99 });
    const context = spawnContext();

    expect(liveCrates(system)).toHaveLength(0);
    const first = refreshFor(system, DT, context);
    expect(first.map((crate) => crate.kind).sort()).toEqual(['ammo', 'medkit']);
    expect(system.liveCount('ammo')).toBe(1);
    expect(system.liveCount('medkit')).toBe(1);

    // Nothing for the whole interval, then exactly one more of each.
    const quiet = refreshFor(system, PICKUPS.refreshInterval - 0.5, context);
    expect(quiet).toHaveLength(0);
    const second = refreshFor(system, 0.6, context);
    expect(second.map((crate) => crate.kind).sort()).toEqual(['ammo', 'medkit']);
    expect(system.liveCount()).toBe(4);
  });

  it('stops refreshing a kind at the cap, and resumes it on a later beat once it is below', () => {
    const system = createPickupSystem({ seed: 7 });
    const context = spawnContext();

    // Two beats fill both kinds to the cap; the following beats add nothing at all.
    refreshFor(system, PICKUPS.refreshInterval * 2 + 0.1, context);
    expect(system.liveCount('ammo')).toBe(PICKUPS.maxPerKind);
    expect(system.liveCount('medkit')).toBe(PICKUPS.maxPerKind);
    const atCap = refreshFor(system, PICKUPS.refreshInterval * 3, context);
    expect(atCap).toHaveLength(0);
    expect(system.liveCount()).toBe(PICKUPS.maxPerKind * PICKUP_KINDS.length);

    // Take one ammo box, and the *next* beat restores that kind — and only that kind, because
    // the medkits are still at the cap. This is the "不是最大数量时恢复刷新" half, and it is a
    // per-kind decision rather than a global "is the field full".
    const ammo = liveCrates(system).find((crate) => crate.kind === 'ammo');
    if (!ammo) throw new Error('no ammo crate to take');
    expect(system.collect({ x: ammo.position.x, y: 0, z: ammo.position.z })).toBe(ammo);
    expect(system.liveCount('ammo')).toBe(PICKUPS.maxPerKind - 1);

    const resumed = refreshFor(system, PICKUPS.refreshInterval + 0.1, context);
    expect(resumed.map((crate) => crate.kind)).toEqual(['ammo']);
    expect(system.liveCount('ammo')).toBe(PICKUPS.maxPerKind);
    expect(system.liveCount('medkit')).toBe(PICKUPS.maxPerKind);
  });

  it('places every crate inside the arena, on the floor, clear of geometry and of each other', () => {
    const system = createPickupSystem({ seed: 1234 });
    const obstacles = realObstacles().obstacles;
    const context = spawnContext();
    const half = PICKUPS.size * 0.5;

    // Collect a crate every beat so the field keeps refreshing for a long stretch — several
    // dozen placements, which is where a sampler that only *usually* finds a legal spot shows.
    const seen: Pickup[] = [];
    for (let beat = 0; beat < 24; beat += 1) {
      seen.push(...refreshFor(system, PICKUPS.refreshInterval + 0.05, context));
      const live = liveCrates(system);
      for (const crate of live) {
        // On the floor: the centre is half its own edge above y = 0.
        expect(crate.position.y).toBeCloseTo(half, 6);
        // Inside the arena, clear of the fence.
        const limit = SIM.arenaHalfSize - PICKUPS.fenceMargin - half;
        expect(Math.abs(crate.position.x)).toBeLessThanOrEqual(limit + 1e-6);
        expect(Math.abs(crate.position.z)).toBeLessThanOrEqual(limit + 1e-6);
        // Not inside a piece of level geometry (the strict-overlap rule the placer uses).
        for (const box of obstacles) {
          const overlapping =
            Math.abs(crate.position.x - box.center.x) < box.halfExtents.x + half &&
            Math.abs(crate.position.y - box.center.y) < box.halfExtents.y + half &&
            Math.abs(crate.position.z - box.center.z) < box.halfExtents.z + half;
          expect(overlapping).toBe(false);
        }
        // Never in the player's lap, and never on top of another crate.
        expect(Math.hypot(crate.position.x - context.playerPosition.x, crate.position.z - context.playerPosition.z))
          .toBeGreaterThanOrEqual(PICKUPS.minDistanceFromPlayer - 1e-6);
      }
      for (let i = 0; i < live.length; i += 1) {
        for (let j = i + 1; j < live.length; j += 1) {
          const a = live[i];
          const b = live[j];
          if (!a || !b) continue;
          expect(overlaps(a, b)).toBe(false);
          expect(Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z)).toBeGreaterThanOrEqual(
            PICKUPS.minSeparation - 1e-6,
          );
        }
      }
      // Take one so the next beat has room to place again.
      const first = live[0];
      if (first) system.collect({ x: first.position.x, y: 0, z: first.position.z });
    }
    expect(seen.length).toBeGreaterThan(20);
  });

  it('re-arms the clock and the placement stream on a reset', () => {
    const a = createPickupSystem({ seed: 5 });
    // Same seed as `a` for the reset comparison, and a different one for the "random area"
    // control below: a stream that was *not* re-seeded would break the first, and a stream that
    // ignored its seed would break the second.
    const b = createPickupSystem({ seed: 6 });
    const context = spawnContext();
    const firstRun = refreshFor(a, PICKUPS.refreshInterval * 2 + 0.1, context).map((crate) => ({
      kind: crate.kind,
      position: { ...crate.position },
    }));

    a.reset();
    expect(liveCrates(a)).toHaveLength(0);
    const secondRun = refreshFor(a, PICKUPS.refreshInterval * 2 + 0.1, context).map((crate) => ({
      kind: crate.kind,
      position: { ...crate.position },
    }));
    expect(secondRun).toEqual(firstRun);
    // Two different seeds are two different maps of crates, which is what "random area" means.
    const other = refreshFor(b, PICKUPS.refreshInterval * 2 + 0.1, spawnContext()).map((crate) => ({ ...crate.position }));
    expect(other).not.toEqual(firstRun.map((entry) => entry.position));
  });});

describe('supply crates: using them', () => {
  it('reaches only what is inside the interaction range, and picks the nearest', () => {
    const system = createPickupSystem({ seed: 3 });
    const context = spawnContext();
    refreshFor(system, DT, context);
    const ammo = liveCrates(system).find((crate) => crate.kind === 'ammo');
    const medkit = liveCrates(system).find((crate) => crate.kind === 'medkit');
    if (!ammo || !medkit) throw new Error('the first beat did not deliver a pair');

    // A metre away: it is reachable.
    expect(system.nearest({ x: ammo.position.x + 1, y: 0, z: ammo.position.z })).toBe(ammo);
    // Just outside the configured range: it is not, and the prompt (which asks the same
    // question) therefore cannot offer it either.
    const outside = { x: ammo.position.x + PICKUPS.interactRange + 0.5, y: 0, z: ammo.position.z };
    const other = system.nearest(outside);
    expect(other === ammo).toBe(false);

    // Nowhere near anything: no crate, and `collect` is a no-op rather than an error.
    const far = { x: ammo.position.x + 500, y: 0, z: ammo.position.z };
    expect(system.nearest(far)).toBeNull();
    expect(system.collect(far)).toBeNull();
    expect(system.liveCount()).toBe(2);
  });
});

describe('supply crates: wired into the run', () => {
  interface Run {
    readonly world: World;
    readonly events: EventBus;
    readonly crateSpawns: { id: number; kind: string; amount?: number }[];
    readonly picked: { id: number; kind: string; amount: number }[];
    readonly seen: string[];
  }

  function makeRun(seed = 31337): Run {
    const events = new EventBus();
    const seen: string[] = [];
    const crateSpawns: { id: number; kind: string }[] = [];
    const picked: { id: number; kind: string; amount: number }[] = [];
    const world = createWorld({ events, seed });
    events.on('pickup:spawned', (payload) => {
      seen.push('pickup:spawned');
      crateSpawns.push({ id: payload.id, kind: payload.kind });
    });
    events.on('pickup:collected', (payload) => {
      seen.push('pickup:collected');
      picked.push({ id: payload.id, kind: payload.kind, amount: payload.amount });
    });
    return { world, events, crateSpawns, picked, seen };
  }

  /** Stands the player on a crate, so `E` reaches it. */
  function standOn(world: World, crate: Pickup): void {
    world.player.position.x = crate.position.x;
    world.player.position.z = crate.position.z;
    world.player.position.y = 0;
  }

  function firstCrate(world: World, kind: string): Pickup {
    const crate = world.pickups.pickups.find((slot) => slot.active && slot.kind === kind);
    if (!crate) throw new Error(`no live ${kind} crate`);
    return crate;
  }

  it('delivers a pair on the first tick of the run', () => {
    const run = makeRun();
    expect(run.world.pickups.liveCount()).toBe(0);
    run.world.tick(DT, intent());
    expect(run.world.pickups.liveCount('ammo')).toBe(1);
    expect(run.world.pickups.liveCount('medkit')).toBe(1);
    expect(run.seen).toContain('pickup:spawned');
    expect(run.crateSpawns.map((entry) => entry.kind).sort()).toEqual(['ammo', 'medkit']);
  });

  it('gives 90 rounds for an ammo box, and the box is gone', () => {
    const run = makeRun();
    const { world } = run;
    world.tick(DT, intent());
    // Spend some ammunition first, so the grant has somewhere to go.
    world.player.weapon.reserve = 40;
    const crate = firstCrate(world, 'ammo');
    standOn(world, crate);
    expect(world.interactTarget()?.kind).toBe('ammo');

    world.tick(DT, intent({ interact: true }));
    expect(world.player.weapon.reserve).toBe(40 + PICKUPS.ammoRounds);
    expect(run.picked).toEqual([{ id: crate.id, kind: 'ammo', amount: PICKUPS.ammoRounds }]);
    expect(crate.active).toBe(false);
    expect(world.interactTarget()).toBeNull();
    // The magazine is not topped up: a crate is a supply, not a reload.
    expect(world.player.weapon.magazine).toBe(WEAPON.magazineSize);
  });

  it('gives 50 health for a medkit, and reports the amount it really restored', () => {
    const run = makeRun();
    const { world } = run;
    world.tick(DT, intent());
    world.player.health = 60;
    const crate = firstCrate(world, 'medkit');
    standOn(world, crate);

    world.tick(DT, intent({ interact: true }));
    // A tolerance rather than an exact value: health regenerates on the same tick the crate is
    // used (12 HP/s for one 60 Hz step), which is a different feature doing its job.
    expect(world.player.health).toBeGreaterThan(60 + PICKUPS.healAmount - 0.5);
    expect(world.player.health).toBeLessThanOrEqual(60 + PICKUPS.healAmount + 0.5);
    expect(run.picked).toEqual([{ id: crate.id, kind: 'medkit', amount: PICKUPS.healAmount }]);
    expect(crate.active).toBe(false);
  });

  it('spends a crate that had nothing to give, and says so honestly', () => {
    const run = makeRun();
    const { world } = run;
    world.tick(DT, intent());

    // A medkit at full health: nothing to heal, and no health event either.
    let healthEvents = 0;
    run.events.on('player:stateChanged', () => {
      healthEvents += 1;
    });
    const medkit = firstCrate(world, 'medkit');
    standOn(world, medkit);
    world.player.health = PLAYER.maxHealth;
    world.tick(DT, intent({ interact: true }));
    expect(world.player.health).toBe(PLAYER.maxHealth);
    expect(run.picked.at(-1)?.amount).toBe(0);
    expect(medkit.active).toBe(false);
    expect(healthEvents).toBe(0);

    // An ammo box at the reserve cap: same rule, and the reserve cannot exceed the cap.
    world.player.weapon.reserve = WEAPON.maxReserveAmmo;
    const ammo = firstCrate(world, 'ammo');
    standOn(world, ammo);
    world.tick(DT, intent({ interact: true }));
    expect(world.player.weapon.reserve).toBe(WEAPON.maxReserveAmmo);
    expect(run.picked.at(-1)?.amount).toBe(0);
    expect(ammo.active).toBe(false);
  });

  it('does nothing at all when E is pressed with no crate in reach', () => {
    const run = makeRun();
    const { world } = run;
    world.tick(DT, intent());
    // The player spawns at z = +8, and crates keep their distance from them.
    expect(world.interactTarget()).toBeNull();
    const before = world.pickups.liveCount();
    world.tick(DT, intent({ interact: true }));
    expect(world.pickups.liveCount()).toBe(before);
    expect(run.picked).toHaveLength(0);
  });

  it('keeps the field stocked at the cap and refreshed over a long run', () => {
    const run = makeRun();
    const { world } = run;
    // Three minutes of the director's clock with nobody collecting: the crates fill to the cap
    // and then stay there, and nothing is ever delivered on top of something else.
    for (let i = 0; i < 60 * 180; i += 1) {
      world.player.health = PLAYER.maxHealth;
      world.tick(DT, intent());
      for (const kind of PICKUP_KINDS) {
        expect(world.pickups.liveCount(kind)).toBeLessThanOrEqual(PICKUPS.maxPerKind);
      }
    }
    expect(world.pickups.liveCount('ammo')).toBe(PICKUPS.maxPerKind);
    expect(world.pickups.liveCount('medkit')).toBe(PICKUPS.maxPerKind);
  });

  it('clears the field on a restart, and starts delivering again', () => {
    const run = makeRun();
    const { world } = run;
    for (let i = 0; i < 60; i += 1) world.tick(DT, intent());
    expect(world.pickups.liveCount()).toBeGreaterThan(0);

    world.reset();
    expect(world.pickups.liveCount()).toBe(0);
    world.tick(DT, intent());
    expect(world.pickups.liveCount('ammo')).toBe(1);
    expect(world.pickups.liveCount('medkit')).toBe(1);
  });
});
