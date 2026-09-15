/**
 * Whole-world integration tests.
 *
 * The unit tests each pin one system. This file drives the entire simulation 鈥? * director-less but otherwise complete 鈥?through synthetic input, which is the
 * only way to catch the class of bug that lives *between* systems: a stale aim
 * solved before movement, a shot resolved against last tick's hitboxes, an
 * accumulator that only misbehaves once the loop is running.
 *
 * It is also the cheapest possible smoke test. If `npm test` is green, the
 * simulation boots, ticks, shoots, hits, damages and kills with no renderer.
 */

import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '#/game/World';
import { EventBus } from '#/core/events';
import type { InputIntent } from '#/core/input';
import { PLAYER, HITSTOP, SIM, WEAPON } from '#/core/config';
import { distanceXZ } from '#/core/math/vec3';

/**
 * A blank intent, so each test only states what it changes.
 *
 * `toggleView` is never set: the view is changed through `World.toggleView()` (the same call `V`
 * makes), not through the intent, so a test that wants a mode sets it once with {@link setView}.
 */
function intent(overrides: Partial<InputIntent> = {}): InputIntent {
  return {
    move: { forward: 0, right: 0 },
    sprint: false,
    jump: false,
    fire: false,
    aim: false,
    reload: false,
    throwItem: false,
    toggleView: false,
    lookDeltaX: 0,
    lookDeltaY: 0,
    ...overrides,
  };
}

/**
 * Puts a world into a named view mode.
 *
 * Every test in this file was written against the over-the-shoulder rig, and its numbers — the
 * muzzle's lateral offset, the camera's distance behind the player, whether a level shot from
 * spawn clears a chest-height dummy — are that rig's numbers. Since phase 8 the game boots into
 * first person, so the tests state the mode they are actually about instead of inheriting it.
 * `createWorld`'s own default is asserted once, in the phase-8 block at the end of the file.
 */
function setView(world: World, mode: 'firstPerson' | 'thirdPerson'): void {
  if (world.camera.viewMode !== mode) world.toggleView();
  expect(world.camera.viewMode).toBe(mode);
}

/**
 * Stands the player 17 m south of a target dummy and aims at its **body**, in any view mode.
 *
 * "Fire straight out of spawn and hit something" used to work by geometry rather than by intent:
 * the near dummy sits at z = −9 with the player at z = 8, and the shoulder camera's *lowered*
 * muzzle at y = 1.26 happened to sit on the line to a 1.1 m-tall body. Eye height is 1.6, so from
 * the eye that same level ray passes over the dummy's head — correct first-person behaviour (you
 * have to look at what you are shooting), but it made a test whose subject is the damage chain
 * depend on which camera the game happened to boot into.
 *
 * Aiming with `pitch = atan2(eye − target)`, exactly as a player would, removes that dependence.
 * The target point is read from the **live body's own body hitbox** rather than re-derived from
 * the level spec: the dummy's boxes are scaled from `ENEMY_DUMMY` when the store builds it, so the
 * spec's `bodyHeight` is not the hitbox's height, and a hand-computed aim point 8 cm high is
 * enough to miss.
 */
function aimAtDummy(world: World, dummyIndex = 0): void {
  const spec = world.level.targets[dummyIndex];
  const target = world.enemies.targets[dummyIndex];
  if (!spec || !target) throw new Error(`world.test: no target at index ${dummyIndex}`);
  const body = target.hitboxes.find((box) => box.zone === 'body');
  if (!body) throw new Error('world.test: the dummy has no body hitbox');

  const distance = 17;
  const eye = world.player.position.y + PLAYER.eyeHeight;
  world.player.position.x = spec.base.x;
  world.player.position.z = spec.base.z + distance;
  world.player.position.y = 0;
  // Yaw 0 faces −Z, and the dummy is straight down −Z from here, so only pitch has to move.
  world.player.yaw = 0;
  // Negative because **positive pitch looks up** in this simulation (`player.ts`), so looking
  // down at something below eye level is a negative angle. Getting this the wrong way round aims
  // the shot over the dummy's head by 2.5 m at 17 m, which is exactly the kind of silent miss that
  // made the old version of this test depend on which camera the game booted into.
  world.player.pitch = -Math.atan2(eye - body.center.y, distance);
}

/** Runs `seconds` of simulation at the fixed tick rate. */
function run(world: World, seconds: number, input: InputIntent): void {
  const dt = 1 / SIM.tickHz;
  const steps = Math.round(seconds * SIM.tickHz);
  for (let i = 0; i < steps; i += 1) world.tick(dt, input);
}

function makeWorld(seed = 1234): World {
  return createWorld({ events: new EventBus(), seed });
}

/**
 * Points the player at the empty sky.
 *
 * Cadence tests must not connect with anything: a hit arms hitstop, which scales
 * the whole simulation's `dt`, and the measured rate then reflects the freeze
 * rather than the weapon. Aiming 80掳 up puts every round into empty air.
 */
function aimAtSky(world: World): void {
  world.player.pitch = 1.4;
}

describe('world boot and state hygiene', () => {
  it('boots with a level, targets and a sane camera', () => {
    const world = makeWorld();
    expect(world.level.props.length).toBeGreaterThan(30);
    expect(world.enemies.targets.length).toBeGreaterThan(4);
    expect(Number.isFinite(world.camera.position.x)).toBe(true);
    expect(Number.isFinite(world.camera.position.y)).toBe(true);
    expect(Number.isFinite(world.camera.position.z)).toBe(true);
    expect(world.player.weapon.magazine).toBe(WEAPON.magazineSize);
  });

  it('never produces NaN in any state vector over a long idle run', () => {
    const world = makeWorld();
    run(world, 20, intent());
    for (const value of [
      world.player.position.x,
      world.player.position.y,
      world.player.position.z,
      world.player.velocity.x,
      world.player.velocity.y,
      world.player.velocity.z,
      world.player.yaw,
      world.player.pitch,
      world.player.weapon.spreadDeg,
      world.camera.position.x,
      world.camera.position.y,
      world.camera.position.z,
    ]) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('keeps the player inside the arena while sprinting in every direction', () => {
    for (const forward of [-1, 0, 1]) {
      for (const right of [-1, 0, 1]) {
        const world = makeWorld();
        // Look around while running, so the movement basis is exercised too.
        run(
          world,
          12,
          intent({ move: { forward, right }, sprint: true, lookDeltaX: 40, lookDeltaY: 12 }),
        );
        expect(Math.abs(world.player.position.x)).toBeLessThanOrEqual(world.level.halfSize);
        expect(Math.abs(world.player.position.z)).toBeLessThanOrEqual(world.level.halfSize);
        expect(world.player.position.y).toBeGreaterThanOrEqual(-0.01);
      }
    }
  });
});

describe('shooting through the real world', () => {
  it('fires at the configured rate when the trigger is held', () => {
    const world = makeWorld();
    aimAtSky(world);
    const before = world.stats.shotsFired;
    run(world, 1, intent({ fire: true }));
    const shots = world.stats.shotsFired - before;
    // 640 RPM is 10.67 rounds per second, and 60/640 s is exactly 5.625 ticks.
    // A one-second window therefore holds 10 or 11 rounds depending on rounding,
    // and the point of the test is that it is nowhere near 9 or 12.
    expect(world.stats.hitstopTicks).toBe(0);
    expect(shots).toBeGreaterThanOrEqual(10);
    expect(shots).toBeLessThanOrEqual(11);
  });

  it('holds the measured rate within 2% of the configured RPM over a magazine', () => {
    // The acceptance criterion is stated over a window long enough that tick
    // quantisation cannot move it: one magazine is 2.8125 s / 30 rounds.
    const world = makeWorld();
    aimAtSky(world);
    const duration = WEAPON.magazineSize / (WEAPON.rpm / 60);
    run(world, duration, intent({ fire: true }));
    const expected = WEAPON.magazineSize;
    const error = Math.abs(world.stats.shotsFired - expected) / expected;
    expect(error).toBeLessThan(0.02);
  });

  it('damages the dummy it is aimed at, straight out of spawn', () => {
    const world = makeWorld();
    aimAtDummy(world);
    run(world, 1, intent({ fire: true }));
    expect(world.stats.shotsFired).toBeGreaterThan(0);
    expect(world.stats.damageDealt).toBeGreaterThan(0);
    const damaged = world.enemies.targets.filter((target) => target.totalDamageTaken > 0);
    expect(damaged.length).toBeGreaterThan(0);
  });

  it('damages the dummy it is aimed at in first person too', () => {
    // The same chain, in the view the game actually boots into. Kept as its own case rather than
    // as a loop over modes: a mode-dependent *shooting* failure is the one thing this feature must
    // never have, so it gets its own red light.
    const world = makeWorld();
    setView(world, 'firstPerson');
    aimAtDummy(world);
    run(world, 1, intent({ fire: true }));
    expect(world.stats.damageDealt).toBeGreaterThan(0);
  });

  it('kills a practice dummy outright when enough rounds land', () => {
    const world = makeWorld();
    const before = world.stats.targetsKilled;
    // Two seconds is ~21 rounds; the nearest dummy has 200 HP, so a handful of
    // hits either kills it or leaves it visibly damaged.
    run(world, 2, intent({ fire: true }));
    expect(world.stats.damageDealt).toBeGreaterThan(0);
    if (world.stats.targetsKilled > before) {
      const dead = world.enemies.targets.find((candidate) => !candidate.alive);
      expect(dead).toBeDefined();
      expect(dead!.health).toBe(0);
    }
  });

  it('cannot shoot a target through the crate between them', () => {
    const world = makeWorld();
    // Stand east of the central crate cluster looking west, with a dummy on the
    // far side. The crate is cover: a 5 m obstacle must always beat a 12 m body,
    // which is the rule that stops "I shot through the wall".
    const crate = world.level.props.find((prop) => prop.id === 'crate-a');
    expect(crate).toBeDefined();
    // Player 7 m east of the crate, at the same height as the crate.
    world.player.position.x = crate!.position.x + 7;
    world.player.position.y = 0;
    world.player.position.z = crate!.position.z;
    // yaw = +蟺/2 points down 鈭扻, i.e. straight at the crate.
    world.player.yaw = Math.PI / 2;
    world.player.pitch = 0;

    const before = world.enemies.targets.reduce((sum, target) => sum + target.totalDamageTaken, 0);
    run(world, 1.5, intent({ fire: true }));
    const after = world.enemies.targets.reduce((sum, target) => sum + target.totalDamageTaken, 0);

    // Every round hit the crate, so no target took damage.
    expect(world.stats.shotsFired).toBeGreaterThan(5);
    expect(after - before).toBe(0);
  });

  it('empties the magazine, then reloads itself from reserve', () => {
    const world = makeWorld();
    // Aimed at a dummy, so the run has impact hitstop and the reload path is exercised with the
    // rest of the chain live rather than in a vacuum.
    aimAtDummy(world);
    // One magazine takes 2.8 s at 640 RPM, plus 1.7 s for the empty reload.
    run(world, 5, intent({ fire: true }));
    expect(world.stats.shotsFired).toBeGreaterThanOrEqual(WEAPON.magazineSize);
    // The reload has drawn from reserve, which is the observable proof it ran.
    expect(world.player.weapon.reserve).toBeLessThan(WEAPON.reserveAmmo);
  });

  it('answers a manual reload request', () => {
    const world = makeWorld();
    run(world, 0.5, intent({ fire: true }));
    const magazineBefore = world.player.weapon.magazine;
    expect(magazineBefore).toBeLessThan(WEAPON.magazineSize);
    world.tick(1 / SIM.tickHz, intent({ reload: true }));
    expect(world.player.weapon.mode).toBe('reloading');
    run(world, WEAPON.reloadTime + 0.1, intent());
    expect(world.player.weapon.magazine).toBe(WEAPON.magazineSize);
  });
});

describe('aim and recoil', () => {
  it('recoil raises the view and settles back to level when fire stops', () => {
    const world = makeWorld();
    run(world, 1, intent({ fire: true }));
    world.updateCamera(1 / 60);
    const climbing = world.camera.pitch;
    // Recoil pushes the camera up relative to where the player is looking.
    expect(climbing).toBeGreaterThan(world.player.pitch);
    // Release and let it recover.
    world.player.pitch = 0;
    run(world, 2, intent());
    world.updateCamera(1 / 60);
    expect(Math.abs(world.camera.pitch - world.player.pitch)).toBeLessThan(0.02);
  });

  it('aiming narrows the field of view and tightens the spread', () => {
    const world = makeWorld();
    const hipFov = world.camera.fovDeg;
    run(world, PLAYER.adsTime + 0.1, intent({ aim: true }));
    // FOV is applied when the frame is drawn, not when it is simulated, so the
    // camera has to be updated once for the change to be observable.
    world.updateCamera(1 / 60);
    expect(world.camera.fovDeg).toBeLessThan(hipFov);
    expect(world.camera.fovDeg).toBeCloseTo(PLAYER.fovAds, 3);
    expect(world.player.weapon.spreadDeg).toBeCloseTo(WEAPON.spreadAdsDeg, 3);
  });

  it('keeps the third-person camera behind the player and the muzzle in front of it', () => {
    const world = makeWorld();
    setView(world, 'thirdPerson');
    for (const look of [0, 60, -120, 200]) {
      run(world, 0.4, intent({ lookDeltaX: look }));
      const toPlayer = distanceXZ(world.camera.position, world.player.position);
      // The camera sits behind the player and the muzzle in front of the camera,
      // which is the invariant that stops a shot from starting inside a wall.
      expect(toPlayer).toBeGreaterThan(0.5);
      expect(toPlayer).toBeLessThan(6);
    }
  });

  it('puts the first-person camera at the eye, with the muzzle ahead of it', () => {
    // The first-person half of the same invariant, and a different statement: there is no boom to
    // keep clear of geometry, so what has to hold is that the camera *is* the eye (no lateral or
    // backward offset at all) and that the tracer still leaves from in front of it.
    const world = makeWorld();
    setView(world, 'firstPerson');
    for (const look of [0, 60, -120, 200]) {
      run(world, 0.4, intent({ lookDeltaX: look }));
      world.updateCamera(1 / 60);

      expect(distanceXZ(world.camera.position, world.player.position)).toBeCloseTo(0, 6);
      expect(world.camera.position.y).toBeCloseTo(world.player.position.y + PLAYER.eyeHeight, 6);

      const muzzle = { x: 0, y: 0, z: 0 };
      world.muzzlePosition(muzzle);
      const forward = { x: 0, y: 0, z: 0 };
      world.aimDirection(forward);

      // The tracer leaves from just under the eye, not from the eye itself — that small drop is
      // what keeps a tracer from reading as a beam out of the middle of the screen.
      expect(muzzle.y).toBeLessThan(world.camera.position.y);
      const fromEye = Math.hypot(
        muzzle.x - world.camera.position.x,
        muzzle.y - world.camera.position.y,
        muzzle.z - world.camera.position.z,
      );
      expect(fromEye).toBeGreaterThan(0);
      expect(fromEye).toBeLessThan(1);

      // And it is **on** the aim axis: the offset is a vector sum of two components orthogonal to
      // `forward`, so moving from the eye to the muzzle cannot change where the shot is pointed.
      // This is the property that makes the whole convergence chain work in either view.
      const along =
        (muzzle.x - world.camera.position.x) * forward.x +
        (muzzle.y - world.camera.position.y) * forward.y +
        (muzzle.z - world.camera.position.z) * forward.z;
      expect(Math.abs(along)).toBeLessThan(1e-9);
    }
  });
});

describe('determinism', () => {
  it('produces identical results for identical seeds and inputs', () => {
    const trace = (seed: number): number[] => {
      const world = createWorld({ events: new EventBus(), seed, levelSeed: 7 });
      const samples: number[] = [];
      for (let i = 0; i < 240; i += 1) {
        world.tick(
          1 / SIM.tickHz,
          intent({ fire: true, move: { forward: 1, right: 0.4 }, lookDeltaX: 1.5, lookDeltaY: 0.4 }),
        );
        if (i % 20 === 0) samples.push(world.player.position.x, world.player.position.z, world.stats.damageDealt);
      }
      return samples;
    };
    expect(trace(99)).toEqual(trace(99));
  });

  it('produces different results for different seeds', () => {
    const trace = (seed: number): number => {
      const world = createWorld({ events: new EventBus(), seed, levelSeed: 7 });
      run(world, 2, intent({ fire: true }));
      return world.stats.damageDealt;
    };
    // Spread is drawn from the seeded RNG, so two seeds must not agree on every
    // round that lands. Compare a set rather than a pair: two seeds can legitimately
    // coincide once, and a single comparison would flake.
    const totals = new Set([trace(1), trace(2), trace(3), trace(4), trace(5)]);
    expect(totals.size).toBeGreaterThan(1);
  });
});

describe('reset', () => {
  it('returns every subsystem to spawn state', () => {
    const world = makeWorld();
    run(world, 1.5, intent({ fire: true, move: { forward: 1, right: 0 } }));
    expect(world.stats.shotsFired).toBeGreaterThan(0);

    world.reset();
    expect(world.stats.shotsFired).toBe(0);
    expect(world.stats.damageDealt).toBe(0);
    expect(world.player.health).toBe(PLAYER.maxHealth);
    expect(world.player.position.z).toBe(8);
    expect(world.player.weapon.magazine).toBe(WEAPON.magazineSize);
    expect(world.player.weapon.reserve).toBe(WEAPON.reserveAmmo);
    expect(world.enemies.damagedCount()).toBe(0);
    expect(world.enemies.aliveCount()).toBe(world.enemies.targets.length);
  });
});

describe('hitstop', () => {
  it('slows the simulation on a hit without skipping ticks', () => {
    const world = makeWorld();
    // Aim at a dummy and fire until something connects.
    let sawHitstop = false;
    for (let i = 0; i < 120; i += 1) {
      const before = world.stats.ticks;
      world.tick(1 / SIM.tickHz, intent({ fire: true }));
      // Ticks always advance by exactly one: hitstop scales `dt`, it never skips.
      expect(world.stats.ticks).toBe(before + 1);
      if (world.stats.hitstopTicks > 0) sawHitstop = true;
    }
    expect(sawHitstop).toBe(true);
  });

  it('keeps hitstop tiers distinct so light and heavy impacts feel different', () => {
    // A guard against "simplifying" hitstop into a fixed per-hit freeze: the tier
    // values must stay distinct or the weight difference disappears.
    expect(HITSTOP.light).toBeLessThan(HITSTOP.medium);
    expect(HITSTOP.medium).toBeLessThan(HITSTOP.heavy);
    expect(HITSTOP.criticalBonus).toBeGreaterThan(0);
    // And the player is never frozen: firing must stay responsive.
    expect(HITSTOP.affectsPlayer).toBe(false);
  });
});
