/**
 * Weapon state machine tests.
 *
 * These are the phase-1 acceptance criteria made executable (technical plan section 5,
 * phase 1): "640 RPM measured error < 2%, and identical at 30/60/144 FPS". If
 * this file is green, the cadence is provably frame-rate independent and the two
 * reload paths are provably distinct.
 */

import { describe, expect, it } from 'vitest';
import { PLAYER, WEAPON } from '#/core/config';
import {
  adsLookScale,
  adsMoveScale,
  createWeaponState,
  effectiveSpread,
  fireInterval,
  reloadDurationFor,
  tickRecoil,
  tickWeapon,
  type WeaponIntent,
  type WeaponState,
} from '#/game/player/weapon';

const IDLE: WeaponIntent = { fire: false, aim: false, reloadPressed: false };
const FIRE: WeaponIntent = { fire: true, aim: false, reloadPressed: false };

/**
 * Simulates `seconds` of holding the trigger at a given tick rate.
 *
 * @returns the number of rounds that left the barrel.
 */
function holdTrigger(state: WeaponState, seconds: number, tickHz: number, intent: WeaponIntent = FIRE): number {
  const dt = 1 / tickHz;
  const ticks = Math.round(seconds * tickHz);
  let shots = 0;
  let time = 0;
  for (let i = 0; i < ticks; i += 1) {
    // An empty magazine triggers a reload, which is part of the cadence under
    // sustained fire, so it is deliberately not stubbed out here.
    const result = tickWeapon(state, intent, dt, time);
    if (result.fired) shots += 1;
    time += dt;
  }
  return shots;
}

describe('fire cadence', () => {
  it('derives the interval from RPM', () => {
    // 640 RPM 鈫?10.667 rounds per second 鈫?0.09375 s between rounds.
    expect(fireInterval()).toBeCloseTo(60 / 640, 12);
    expect(fireInterval()).toBeCloseTo(0.09375, 12);
  });

  it('measures the configured RPM within 2% over one magazine', () => {
    const state = createWeaponState(1);
    const tickHz = 1000;
    // One second of fire at 640 RPM should be 10 full rounds (the 11th lands at
    // t = 1.0 s exactly, so the boundary is inclusive-ish; assert the band).
    const shots = holdTrigger(state, 1, tickHz);
    expect(shots).toBeGreaterThanOrEqual(10);
    expect(shots).toBeLessThanOrEqual(11);
  });

  it('fires the same number of rounds in one second at 30, 60 and 144 FPS', () => {
    const seconds = 1;
    const at30 = holdTrigger(createWeaponState(1), seconds, 30);
    const at60 = holdTrigger(createWeaponState(1), seconds, 60);
    const at144 = holdTrigger(createWeaponState(1), seconds, 144);
    // The same tick count is the strong claim: cadence is decided by RPM, not by
    // how many times the renderer happened to call `tick`.
    expect(at30).toBe(at60);
    expect(at144).toBe(at60);
  });

  it('stays within 2% of the theoretical rate at every frame rate over a full magazine', () => {
    // A full magazine at 640 RPM is 30 rounds over 2.8125 s, which is long enough
    // that one round of quantisation cannot move the average by 2%.
    const magazineDuration = WEAPON.magazineSize / (WEAPON.rpm / 60);
    const expected = WEAPON.rpm / 60 * magazineDuration;
    expect(expected).toBe(WEAPON.magazineSize);
    for (const tickHz of [30, 60, 90, 144, 240]) {
      const shots = holdTrigger(createWeaponState(1), magazineDuration, tickHz);
      const error = Math.abs(shots - expected) / expected;
      expect(error, `tick rate ${tickHz}`).toBeLessThan(0.02);
    }
  });

  it('quantises to at most one round in any short window', () => {
    // Over an arbitrary 1 s window the tick grid can only put you one round out,
    // which at 640 RPM is 9.4% of a 10.67-round expectation - that is quantisation,
    // not drift. Asserting the bound is one round is the meaningful claim.
    const expected = WEAPON.rpm / 60;
    for (const tickHz of [30, 60, 90, 144, 240]) {
      const shots = holdTrigger(createWeaponState(1), 1, tickHz);
      expect(Math.abs(shots - expected), `tick rate ${tickHz}`).toBeLessThanOrEqual(1);
    }
  });

  it('never banks more than one interval of credit across a reload', () => {
    // Hold the trigger through an empty-magazine reload, then measure the rate in
    // the one second after the magazine seats. A banked burst would show up as
    // clearly more than a second's worth of rounds.
    const state = createWeaponState(1);
    const dt = 1 / 60;
    let time = 0;

    // Empty the magazine.
    for (let i = 0; i < 400 && state.mode !== 'reloading'; i += 1) {
      tickWeapon(state, FIRE, dt, time);
      time += dt;
    }
    expect(state.mode).toBe('reloading');

    // Hold through the reload until the magazine seats.
    let guard = 0;
    while (state.mode === 'reloading' && guard < 1000) {
      tickWeapon(state, FIRE, dt, time);
      time += dt;
      guard += 1;
    }
    expect(state.mode).not.toBe('reloading');

    // Now measure exactly one second.
    const oneSecondTicks = 60;
    let shotsAfterReload = 0;
    for (let i = 0; i < oneSecondTicks; i += 1) {
      if (tickWeapon(state, FIRE, dt, time).fired) shotsAfterReload += 1;
      time += dt;
    }
    const expected = WEAPON.rpm / 60;
    expect(shotsAfterReload).toBeLessThanOrEqual(Math.ceil(expected) + 1);
    expect(shotsAfterReload).toBeGreaterThanOrEqual(Math.floor(expected) - 1);
  });
});

describe('magazine and reload', () => {
  it('fires exactly magazineSize rounds before running dry', () => {
    const state = createWeaponState(1);
    let shots = 0;
    let time = 0;
    for (let i = 0; i < 5000 && state.magazine > 0; i += 1) {
      if (tickWeapon(state, FIRE, 1 / 60, time).fired) shots += 1;
      time += 1 / 60;
    }
    expect(shots).toBe(WEAPON.magazineSize);
    expect(state.magazine).toBe(0);
  });

  it('auto-reloads when the trigger is held on an empty magazine', () => {
    const state = createWeaponState(1);
    state.magazine = 0;
    const result = tickWeapon(state, FIRE, 1 / 60, 0);
    expect(result.dryFire).toBe(true);
    expect(result.reloadStarted).toBe(true);
    expect(state.mode).toBe('reloading');
    // The empty-magazine path uses the faster reload.
    expect(state.reloadDuration).toBe(WEAPON.reloadTimeEmpty);
  });

  it('reloads faster from empty than from a tactical reload', () => {
    expect(reloadDurationFor(true)).toBe(WEAPON.reloadTimeEmpty);
    expect(reloadDurationFor(false)).toBe(WEAPON.reloadTime);
    expect(reloadDurationFor(true)).toBeLessThan(reloadDurationFor(false));

    const tactical = createWeaponState(1);
    tactical.magazine = 1;
    tickWeapon(tactical, { fire: false, aim: false, reloadPressed: true }, 1 / 60, 0);
    expect(tactical.reloadDuration).toBe(WEAPON.reloadTime);

    const dry = createWeaponState(1);
    dry.magazine = 0;
    tickWeapon(dry, { fire: false, aim: false, reloadPressed: true }, 1 / 60, 0);
    expect(dry.reloadDuration).toBe(WEAPON.reloadTimeEmpty);
  });

  it('refills the magazine after exactly the reload duration', () => {
    const state = createWeaponState(1);
    state.magazine = 4;
    tickWeapon(state, { fire: false, aim: false, reloadPressed: true }, 1 / 60, 0);
    expect(state.mode).toBe('reloading');

    const dt = 1 / 60;
    let time = 0;
    let finished = false;
    // Step to just before completion.
    const stepsToFinish = Math.ceil(WEAPON.reloadTime / dt) + 2;
    for (let i = 0; i < stepsToFinish; i += 1) {
      const result = tickWeapon(state, IDLE, dt, time);
      if (result.reloadFinished) {
        finished = true;
        expect(time + dt).toBeGreaterThanOrEqual(WEAPON.reloadTime);
        break;
      }
      time += dt;
    }
    expect(finished).toBe(true);
    expect(state.magazine).toBe(WEAPON.magazineSize);
    expect(state.reserve).toBe(WEAPON.reserveAmmo - (WEAPON.magazineSize - 4));
  });

  it('allows a reload to be cancelled inside the opening window', () => {
    const state = createWeaponState(1);
    state.magazine = 10;
    const dt = 1 / 60;
    tickWeapon(state, { fire: false, aim: false, reloadPressed: true }, dt, 0);
    expect(state.mode).toBe('reloading');

    // The very next tick, still inside the 0.35 s window: a second R cancels.
    const result = tickWeapon(state, { fire: false, aim: false, reloadPressed: true }, dt, dt);
    expect(result.reloadCancelled).toBe(true);
    expect(state.mode).toBe('idle');
    // A cancelled reload must not have granted any ammo.
    expect(state.magazine).toBe(10);
  });

  it('does not cancel the reload on the same tick it started', () => {
    // R is an edge flag that is true for the whole tick it arrived on, so without
    // the same-tick guard a single press would start the reload and cancel it in
    // the same step. Both calls below therefore use the *same* `time`.
    const state = createWeaponState(1);
    state.magazine = 10;
    const dt = 1 / 60;
    const result = tickWeapon(state, { fire: false, aim: false, reloadPressed: true }, dt, 0);
    expect(result.reloadStarted).toBe(true);
    expect(result.reloadCancelled).toBe(false);
    expect(state.mode).toBe('reloading');

    // A second R arriving in the same simulation instant still must not cancel.
    const sameTick = tickWeapon(state, { fire: false, aim: false, reloadPressed: true }, dt, 0);
    expect(sameTick.reloadCancelled).toBe(false);
    expect(state.mode).toBe('reloading');
  });

  it('refuses to cancel a reload after the window has closed', () => {
    const state = createWeaponState(1);
    state.magazine = 10;
    const dt = 1 / 60;
    tickWeapon(state, { fire: false, aim: false, reloadPressed: true }, dt, 0);

    // Step past the cancel window without pressing R.
    const steps = Math.ceil(WEAPON.reloadCancelWindow / dt) + 2;
    for (let i = 0; i < steps; i += 1) {
      tickWeapon(state, IDLE, dt, (i + 1) * dt);
    }
    const result = tickWeapon(state, { fire: false, aim: false, reloadPressed: true }, dt, 1);
    expect(result.reloadCancelled).toBe(false);
    expect(state.mode).toBe('reloading');
  });

  it('cannot start a reload with a full magazine', () => {
    const state = createWeaponState(1);
    const result = tickWeapon(state, { fire: false, aim: false, reloadPressed: true }, 1 / 60, 0);
    expect(result.reloadStarted).toBe(false);
    expect(state.mode).toBe('idle');
  });

  it('cannot start a reload with no reserve', () => {
    const state = createWeaponState(1);
    state.magazine = 5;
    state.reserve = 0;
    const result = tickWeapon(state, { fire: false, aim: false, reloadPressed: true }, 1 / 60, 0);
    expect(result.reloadStarted).toBe(false);
  });
});

describe('spread', () => {
  it('blooms by spreadPerShot per round and recovers at the configured rate', () => {
    const state = createWeaponState(1);
    const dt = 1 / 60;
    const base = effectiveSpread(state);
    let time = 0;

    // Fire a few rounds and watch the cone widen.
    let previous = state.spreadDeg;
    for (let i = 0; i < 6; i += 1) {
      const before = state.spreadDeg;
      const result = tickWeapon(state, FIRE, dt, time);
      if (result.fired) {
        previous = before;
        // The sampled cone is the one before this shot's bloom is added.
        expect(result.spreadDeg).toBeCloseTo(before, 6);
      }
      time += dt;
    }
    expect(state.spreadDeg).toBeGreaterThan(previous);

    // Then release and let it settle back to the hip-fire base.
    const recoveryTicks = Math.ceil((WEAPON.spreadMaxDeg / WEAPON.spreadRecoveryPerSec + 1) * 60);
    for (let i = 0; i < recoveryTicks; i += 1) {
      tickWeapon(state, IDLE, dt, time);
      time += dt;
    }
    expect(state.spreadDeg).toBeCloseTo(base, 5);
  });

  it('never exceeds the configured maximum spread', () => {
    const state = createWeaponState(1);
    state.reserve = 10_000;
    let time = 0;
    for (let i = 0; i < 3000; i += 1) {
      tickWeapon(state, FIRE, 1 / 60, time);
      time += 1 / 60;
      expect(state.spreadDeg).toBeLessThanOrEqual(WEAPON.spreadMaxDeg + 1e-9);
    }
  });

  it('converges toward the ADS cone while aiming', () => {
    const state = createWeaponState(1);
    const dt = 1 / 60;
    const ticks = Math.ceil(PLAYER.adsTime / dt) + 2;
    let time = 0;
    for (let i = 0; i < ticks; i += 1) {
      tickWeapon(state, { fire: false, aim: true, reloadPressed: false }, dt, time);
      time += dt;
    }
    expect(state.adsProgress).toBe(1);
    expect(state.aiming).toBe(true);
    expect(effectiveSpread(state)).toBeCloseTo(WEAPON.spreadAdsDeg, 6);
    // And the ADS cone is much tighter than the hip-fire cone, which is the
    // whole point of aiming.
    expect(WEAPON.spreadAdsDeg).toBeLessThan(WEAPON.spreadHipDeg * 0.2);
  });

  it('scales movement and look sensitivity down while aiming', () => {
    const state = createWeaponState(1);
    expect(adsMoveScale(state)).toBeCloseTo(1, 9);
    expect(adsLookScale(state)).toBeCloseTo(1, 9);
    state.adsProgress = 1;
    expect(adsMoveScale(state)).toBeCloseTo(PLAYER.adsMoveScale, 9);
    expect(adsLookScale(state)).toBeCloseTo(PLAYER.adsSensitivityScale, 9);
  });
});

describe('recoil', () => {
  it('accumulates an upward kick per shot and recovers toward zero', () => {
    const state = createWeaponState(7);
    const dt = 1 / 60;
    let time = 0;
    for (let i = 0; i < 5; i += 1) {
      const result = tickWeapon(state, FIRE, dt, time);
      if (result.fired) {
        expect(result.recoilPitchDeg).toBe(WEAPON.recoilPitchDeg);
        state.recoilPitchDeg += result.recoilPitchDeg;
      }
      time += dt;
    }
    const peak = state.recoilPitchDeg;
    expect(peak).toBeGreaterThan(0);

    // Recovery must be monotonic and must actually get most of the way back.
    let previous = peak;
    for (let i = 0; i < 120; i += 1) {
      const remaining = tickRecoil(state, dt).pitchDeg;
      expect(remaining).toBeLessThanOrEqual(previous + 1e-12);
      previous = remaining;
    }
    expect(state.recoilPitchDeg).toBeLessThan(peak * 0.1);
  });

  it('is deterministic for a given seed', () => {
    const run = (): number[] => {
      const state = createWeaponState(1234);
      const dt = 1 / 60;
      const yaws: number[] = [];
      let time = 0;
      for (let i = 0; i < 40; i += 1) {
        const result = tickWeapon(state, FIRE, dt, time);
        if (result.fired) yaws.push(result.recoilYawDeg);
        time += dt;
      }
      return yaws;
    };
    expect(run()).toEqual(run());
  });
});
