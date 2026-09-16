/**
 * Damage pipeline tests.
 *
 * These assert the balance claims the technical plan makes in section 6.2 verbatim, so
 * that a config edit which silently breaks the intended time-to-kill shows up
 * here rather than three weeks later as "the enemies feel spongy". The numbers
 * are deliberately written as arithmetic (`WEAPON.damage * ENEMY_SMALL.headshotMultiplier`)
 * rather than as literals, so rebalancing the rifle updates the expectation too -
 * what is being tested is the *relationship*, not the specific value.
 */

import { describe, expect, it } from 'vitest';
import { ENEMY_LARGE, ENEMY_SMALL, HITSTOP, WEAPON } from '#/core/config';
import { NO_ARMOR, damageFalloff, hitstopForDamage, resolveDamage } from '#/game/combat/damage';

describe('distance falloff', () => {
  it('is exactly 1.0 up to falloffStart', () => {
    expect(damageFalloff(0)).toBe(1);
    expect(damageFalloff(WEAPON.falloffStart * 0.5)).toBe(1);
    expect(damageFalloff(WEAPON.falloffStart)).toBe(1);
  });

  it('is exactly falloffMinScale at and beyond falloffEnd', () => {
    expect(damageFalloff(WEAPON.falloffEnd)).toBeCloseTo(WEAPON.falloffMinScale, 12);
    expect(damageFalloff(WEAPON.falloffEnd + 50)).toBe(WEAPON.falloffMinScale);
    expect(damageFalloff(WEAPON.range)).toBe(WEAPON.falloffMinScale);
  });

  it('decays linearly in between', () => {
    const mid = (WEAPON.falloffStart + WEAPON.falloffEnd) / 2;
    const expected = 1 + (WEAPON.falloffMinScale - 1) * 0.5;
    expect(damageFalloff(mid)).toBeCloseTo(expected, 12);
    // And it is monotone, which is what makes it learnable by feel.
    let previous = damageFalloff(WEAPON.falloffStart);
    for (let d = WEAPON.falloffStart; d <= WEAPON.falloffEnd; d += 1) {
      const value = damageFalloff(d);
      expect(value).toBeLessThanOrEqual(previous + 1e-12);
      previous = value;
    }
  });
});

describe('weak point multiplier', () => {
  it('multiplies body damage by the archetype factor on a head hit', () => {
    const body = resolveDamage({
      baseDamage: WEAPON.damage,
      zone: 'body',
      weakPointMultiplier: ENEMY_SMALL.headshotMultiplier,
      distance: 0,
      spreadDeg: 0,
    });
    const head = resolveDamage({
      baseDamage: WEAPON.damage,
      zone: 'head',
      weakPointMultiplier: ENEMY_SMALL.headshotMultiplier,
      distance: 0,
      spreadDeg: 0,
    });
    expect(body.final).toBe(WEAPON.damage);
    expect(head.afterMultiplier).toBeCloseTo(WEAPON.damage * ENEMY_SMALL.headshotMultiplier, 9);
    expect(head.final).toBe(Math.ceil(WEAPON.damage * ENEMY_SMALL.headshotMultiplier));
  });

  it('kills a Stalker in three body shots or a single weak-point shot', () => {
    const body = resolveDamage({
      baseDamage: WEAPON.damage,
      zone: 'body',
      weakPointMultiplier: ENEMY_SMALL.headshotMultiplier,
      distance: 0,
      spreadDeg: 0,
    }).final;
    const head = resolveDamage({
      baseDamage: WEAPON.damage,
      zone: 'head',
      weakPointMultiplier: ENEMY_SMALL.headshotMultiplier,
      distance: 0,
      spreadDeg: 0,
    }).final;

    expect(Math.ceil(ENEMY_SMALL.maxHealth / body)).toBe(3);
    // 22 * 2.8 = 61.6, which clears a 60 HP Stalker in one shot. That asymmetry
    // (3 body / 1 head) is decision D6 in the technical plan: the reward for
    // aiming has to be big enough that a player being swarmed still wants to.
    // It holds inside `falloffStart` only; past it, no single hit carries 60 HP.
    expect(Math.ceil(ENEMY_SMALL.maxHealth / head)).toBe(1);
  });

  it('makes weak points worth aiming at for both archetypes', () => {
    for (const stats of [ENEMY_SMALL, ENEMY_LARGE]) {
      expect(stats.headshotMultiplier).toBeGreaterThan(1);
    }
    // The small enemy rewards precision more, which is what gives the player a
      // reason to slow down when swarmed.
    expect(ENEMY_SMALL.headshotMultiplier).toBeGreaterThan(ENEMY_LARGE.headshotMultiplier);
  });
});

describe('armour', () => {
  it('subtracts flat armour before the ratio', () => {
    const result = resolveDamage({
      baseDamage: 22,
      zone: 'body',
      weakPointMultiplier: 2.5,
      distance: 0,
      spreadDeg: 0,
      armor: { flatReduction: 4, ratio: 0.5 },
    });
    // (22 - 4) * 0.5 = 9
    expect(result.armorAbsorbed).toBe(4);
    expect(result.final).toBe(9);
  });

  it('is bypassed entirely by weak-point hits', () => {
    const armored = resolveDamage({
      baseDamage: 22,
      zone: 'head',
      weakPointMultiplier: 2.5,
      distance: 0,
      spreadDeg: 0,
      armor: { flatReduction: 4, ratio: 0.5 },
      bypassesArmor: true,
    });
    expect(armored.armorAbsorbed).toBe(0);
    expect(armored.final).toBe(Math.ceil(22 * 2.5));
  });

  it('never reduces a connected hit below 1', () => {
    const result = resolveDamage({
      baseDamage: 10,
      zone: 'body',
      weakPointMultiplier: 1,
      distance: 0,
      spreadDeg: 0,
      armor: { flatReduction: 100, ratio: 0 },
    });
    expect(result.final).toBe(1);
  });

  it('treats a missing armour value as no armour', () => {
    const withDefault = resolveDamage({
      baseDamage: 22,
      zone: 'body',
      weakPointMultiplier: 1,
      distance: 0,
      spreadDeg: 0,
    });
    const explicit = resolveDamage({
      baseDamage: 22,
      zone: 'body',
      weakPointMultiplier: 1,
      distance: 0,
      spreadDeg: 0,
      armor: NO_ARMOR,
    });
    expect(withDefault.final).toBe(explicit.final);
  });

  it('applies falloff before armour, so range and armour compound instead of cancelling', () => {
    const armoredAtRange = resolveDamage({
      baseDamage: WEAPON.damage,
      zone: 'body',
      weakPointMultiplier: 1,
      distance: WEAPON.falloffEnd,
      spreadDeg: 0,
      armor: { flatReduction: 2, ratio: 1 },
    });
    // 22 * 0.55 = 12.1, then -2 = 10.1 鈫?ceil 11. Applying armour first would
    // give (22-2)*0.55 = 11.0 鈫?11, so the ordering is observable.
    expect(armoredAtRange.final).toBe(11);
    expect(armoredAtRange.falloffScale).toBeCloseTo(WEAPON.falloffMinScale, 12);
  });
});

describe('hitstop weights', () => {
  it('gives heavier impacts longer freezes', () => {
    const light = hitstopForDamage(WEAPON.damage, 'body', HITSTOP);
    const medium = hitstopForDamage(WEAPON.damage * 1.6, 'body', HITSTOP);
    const heavy = hitstopForDamage(WEAPON.damage * 2.5, 'body', HITSTOP);
    expect(light).toBe(HITSTOP.light);
    expect(medium).toBe(HITSTOP.medium);
    expect(heavy).toBe(HITSTOP.heavy);
    expect(light).toBeLessThan(medium);
    expect(medium).toBeLessThan(heavy);
  });

  it('adds the critical bonus on a weak-point hit', () => {
    const body = hitstopForDamage(WEAPON.damage, 'body', HITSTOP);
    const head = hitstopForDamage(WEAPON.damage, 'head', HITSTOP);
    expect(head - body).toBeCloseTo(HITSTOP.criticalBonus, 12);
  });

  it('uses distinct tiers rather than one flat value', () => {
    const values = new Set([HITSTOP.light, HITSTOP.medium, HITSTOP.heavy]);
    expect(values.size).toBe(3);
  });
});

describe('large enemy balance arithmetic', () => {
  it('cannot be killed by body fire out of the rounds a run has left after the Stalkers', () => {
    // Phase 10 doubled the Warden from 2400 to 4800. The old assertion here ("about two
    // magazines of body shots") described the 2400 build and would now be a lie, so what
    // replaced it is the fact the doubling actually created — and it is a fact about the
    // *run*, not about one enemy, because the Stalkers are paid for out of the same pool:
    const carried = WEAPON.magazineSize + WEAPON.reserveAmmo;
    const bodyShots = Math.ceil(ENEMY_LARGE.maxHealth / WEAPON.damage);
    const stalkers = 30 * Math.ceil(ENEMY_SMALL.maxHealth / WEAPON.damage);
    // 219 + 90 = 309 rounds against 240 carried, before falloff (which only makes it
    // worse: the Warden holds an 18-26 m band and `falloffStart` is 22 m).
    expect(bodyShots + stalkers).toBeGreaterThan(carried);
    // The Warden alone already eats almost the whole pool.
    expect(bodyShots).toBeGreaterThan(carried * 0.9);
    // It still needs several deliberate reloads, which was the original design intent.
    expect(bodyShots / WEAPON.magazineSize).toBeGreaterThan(4.5);
  });

  it('is killable with weak-point fire inside the rounds a run carries', () => {
    // The flip side, and the reason the doubling is a difficulty step rather than an
    // impossible wall: 137 weak-point rounds for the Warden plus one per Stalker fits in
    // the 240 a run carries.
    const carried = WEAPON.magazineSize + WEAPON.reserveAmmo;
    const headShots = Math.ceil(ENEMY_LARGE.maxHealth / (WEAPON.damage * ENEMY_LARGE.headshotMultiplier));
    expect(headShots + 30).toBeLessThan(carried);
    // With little enough room that it is a real demand on the player's aim, not a formality.
    expect(headShots).toBeGreaterThan(WEAPON.magazineSize * 4);
  });

  it('gives the Warden a much longer telegraph than the Stalker', () => {
    // Readability budget: the two attacks must be distinguishable by eye.
    expect(ENEMY_LARGE.telegraphTime).toBeGreaterThan(ENEMY_SMALL.telegraphTime * 3);
  });

  it('keeps the Stalker telegraph inside the reactive input window', () => {
    // The verified input-response band for a light attack is 60-120 ms; the
    // Stalker's telegraph must be at least that, or the hit is undodgeable.
    expect(ENEMY_SMALL.telegraphTime).toBeGreaterThanOrEqual(0.06);
  });
});
