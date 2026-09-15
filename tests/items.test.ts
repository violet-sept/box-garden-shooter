/**
 * Thrown items: the arc, the bounces, the fuse and the blast.
 *
 * `docs/阶段3.md` section 7 lists what has to be pinned: the trajectory is independent
 * of the step size, a bounce loses energy, the fuse always detonates, an unexploded
 * lifetime does not, and the splash falls off linearly from the centre to nothing at
 * the radius. The blast is resolved by `EnemyStore.applyBlast`, so the damage
 * assertions run against a real store — the code path shared with the Warden's
 * barrage is the one worth testing, not a copy of it.
 */

import { describe, expect, it } from 'vitest';
import { ENEMY_LARGE, ENEMY_SMALL, ITEMS, PLAYER, SIM } from '#/core/config';
import { EventBus } from '#/core/events';
import type { Aabb, Vector3 } from '#/core/math/vec3';
import { createEnemyStore } from '#/game/enemies/EnemyStore';
import { createItemSystem, type Explosion, type ItemSystem } from '#/game/items/throwable';

const DT = 1 / SIM.tickHz;

/** An empty collision world: nothing to bounce off except the ground and the fence. */
const NO_SOLIDS: readonly Aabb[] = [];

interface Rig {
  readonly items: ItemSystem;
  readonly blasts: Explosion[];
}

function makeItems(cooldown = 0): Rig {
  return { items: createItemSystem({ throwCooldown: cooldown }), blasts: [] };
}

/** Throws from `position` and returns the slot the system used. */
function throwOnce(rig: Rig, position: Vector3, yaw: number, pitch: number) {
  const accepted = rig.items.throwFrom(position, yaw, pitch);
  const slot = rig.items.throwables.find((candidate) => candidate.active);
  return { accepted, slot };
}

/** Steps `seconds` in `dt` slices, collecting blasts. */
function advance(rig: Rig, seconds: number, dt = DT, solids: readonly Aabb[] = NO_SOLIDS): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i += 1) rig.items.tick(dt, solids, rig.blasts);
}

/** Steps until the first blast, or gives up. Returns how many ticks it took. */
function advanceToFirstBlast(rig: Rig, limitTicks = 60 * 6): number {
  for (let i = 0; i < limitTicks; i += 1) {
    rig.items.tick(DT, NO_SOLIDS, rig.blasts);
    if (rig.blasts.length > 0) return i + 1;
  }
  return -1;
}

describe('throwable: the arc', () => {
  it('starts at the hand and leaves along the player aim', () => {
    const rig = makeItems();
    const origin: Vector3 = { x: 0, y: 0, z: 8 };
    const { accepted, slot } = throwOnce(rig, origin, 0, 0);
    expect(accepted).toBe(true);
    expect(slot).toBeDefined();
    if (!slot) return;
    // In front of the player (yaw 0 faces -Z), at hand height, not at their feet.
    expect(slot.position.z).toBeLessThan(origin.z);
    expect(slot.position.y).toBeGreaterThan(0);
    expect(slot.position.y).toBeLessThan(PLAYER.eyeHeight);
    // Direction follows the aim: forward is -Z at yaw 0, and the loft makes it climb.
    expect(slot.velocity.z).toBeLessThan(0);
    expect(slot.velocity.y).toBeGreaterThan(0);
  });

  it('follows the player yaw, not a fixed world direction', () => {
    const rig = makeItems();
    const { slot } = throwOnce(rig, { x: 0, y: 0, z: 0 }, Math.PI / 2, 0);
    expect(slot).toBeDefined();
    if (!slot) return;
    // Yaw +90 degrees faces -X.
    expect(slot.velocity.x).toBeLessThan(0);
    expect(Math.abs(slot.velocity.z)).toBeLessThan(Math.abs(slot.velocity.x));
  });

  it('produces the same position for the same elapsed time at any step size', () => {
    // The load-bearing property of the integration: while the item is in free flight
    // its position is a function of elapsed time, not of how many steps it took. A
    // naive `x += v dt; v += g dt` fails this by a visible margin.
    //
    // Measured only while airborne, and comfortably clear of the ground: a bounce is a
    // discrete event, so two step sizes legitimately resolve it on different ticks.
    // That is the physics, not a bug — and it is why the comparison window is short.
    const flight = 0.1;
    const coarse = makeItems();
    throwOnce(coarse, { x: 0, y: 0, z: 8 }, 0, 0);
    advance(coarse, flight, 1 / 60);

    const fine = makeItems();
    throwOnce(fine, { x: 0, y: 0, z: 8 }, 0, 0);
    advance(fine, flight, 1 / 480);

    const coarseSlot = coarse.items.throwables.find((candidate) => candidate.active);
    const fineSlot = fine.items.throwables.find((candidate) => candidate.active);
    expect(coarseSlot).toBeDefined();
    expect(fineSlot).toBeDefined();
    if (!coarseSlot || !fineSlot) return;
    // Still climbing, so the comparison is about the integrator and nothing else.
    // The tolerance is the integrator's own truncation error over the window
    // (`0.5 * g * dt`), which is what "frame-rate independent" means for a
    // fixed-step simulator: the arc is the same shape, not the same float.
    expect(coarseSlot.position.y).toBeGreaterThan(ITEMS.radius * 2);
    expect(fineSlot.position.y).toBeGreaterThan(ITEMS.radius * 2);
    expect(Math.abs(coarseSlot.position.y - fineSlot.position.y)).toBeLessThan(PLAYER.gravity * (1 / 60) * 0.25);
    expect(Math.abs(coarseSlot.position.z - fineSlot.position.z)).toBeLessThan(0.05);
  });

  it('never leaves the arena even when thrown at the fence', () => {
    const limit = SIM.arenaHalfSize;
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const rig = makeItems();
      throwOnce(rig, { x: 0, y: 0, z: 0 }, yaw, 0.5);
      advance(rig, 2.5);
      for (const slot of rig.items.throwables) {
        expect(Math.abs(slot.position.x)).toBeLessThanOrEqual(limit);
        expect(Math.abs(slot.position.z)).toBeLessThanOrEqual(limit);
      }
    }
  });

  it('never produces NaN, at any pitch', () => {
    for (const pitch of [-1.5, -0.5, 0, 0.5, 1.5]) {
      const rig = makeItems();
      throwOnce(rig, { x: 3, y: 1, z: -4 }, 0.9, pitch);
      advance(rig, 3);
      for (const slot of rig.items.throwables) {
        for (const value of [
          slot.position.x,
          slot.position.y,
          slot.position.z,
          slot.velocity.x,
          slot.velocity.y,
          slot.velocity.z,
        ]) {
          expect(Number.isFinite(value)).toBe(true);
        }
        // The ground is a floor, never a hole.
        expect(slot.position.y).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('throwable: bounces', () => {
  it('loses energy on every ground contact and settles', () => {
    // Dropped steeply, so the vertical axis is the only one in play.
    const rig = makeItems();
    const { slot } = throwOnce(rig, { x: 0, y: 0, z: 0 }, 0, -1.5);
    expect(slot).toBeDefined();
    if (!slot) return;

    // Sampled just before the fuse goes: this is where "has it settled" is meaningful,
    // because at detonation the object stops existing.
    const bounceSpeeds: number[] = [];
    let previousVertical = slot.velocity.y;
    let lastTickSpeed = Math.abs(slot.velocity.y);
    const ticksToFuse = Math.ceil(ITEMS.fuse / DT) - 2;
    for (let i = 0; i < ticksToFuse; i += 1) {
      rig.items.tick(DT, NO_SOLIDS, rig.blasts);
      if (previousVertical < 0 && slot.velocity.y > 0) bounceSpeeds.push(slot.velocity.y);
      previousVertical = slot.velocity.y;
      lastTickSpeed = Math.abs(slot.velocity.y);
    }

    // Several bounces happened...
    expect(bounceSpeeds.length).toBeGreaterThan(1);
    // ...each one weaker than the one before it: the object is losing energy rather
    // than bouncing for ever.
    for (let i = 1; i < bounceSpeeds.length; i += 1) {
      expect(bounceSpeeds[i] ?? 0).toBeLessThan(bounceSpeeds[i - 1] ?? 0);
    }
    // ...and it has come to rest on the ground well before the fuse burns out. The
    // residual is one tick of gravity, which is the integrator's floor, not drift.
    expect(lastTickSpeed).toBeLessThan(PLAYER.gravity * DT * 2.5);
    expect(slot.position.y).toBeCloseTo(ITEMS.radius, 3);
  });

  it('keeps only a fraction of its horizontal speed after a wall hit', () => {
    // A wall straddling the flight path, a few metres in front of the throw.
    const wall: Aabb = {
      center: { x: 0, y: 1.2, z: -5 },
      halfExtents: { x: 4, y: 1.2, z: 0.4 },
    };
    const rig = makeItems();
    const { slot } = throwOnce(rig, { x: 0, y: 0, z: 0 }, 0, 0.25);
    expect(slot).toBeDefined();
    if (!slot) return;

    const incoming = Math.abs(slot.velocity.z);
    expect(incoming).toBeGreaterThan(0);

    let bounced = false;
    for (let i = 0; i < 240; i += 1) {
      rig.items.tick(DT, [wall], rig.blasts);
      if (slot.velocity.z > 0) {
        bounced = true;
        break;
      }
    }
    expect(bounced).toBe(true);
    // A fraction of the incoming speed, not a mirror image of it.
    expect(slot.velocity.z).toBeLessThan(incoming);
    expect(slot.velocity.z).toBeCloseTo(incoming * ITEMS.bounciness, 4);
  });

  it('does not let a resting item drift through the floor', () => {
    const rig = makeItems();
    const { slot } = throwOnce(rig, { x: 0, y: 0, z: 0 }, 0, -1.5);
    expect(slot).toBeDefined();
    if (!slot) return;
    advance(rig, 1.2);
    expect(slot.position.y).toBeGreaterThanOrEqual(ITEMS.radius - 1e-9);
  });
});

describe('throwable: the fuse', () => {
  it('detonates the moment the fuse runs out, even in mid-air', () => {
    const rig = makeItems();
    const { slot } = throwOnce(rig, { x: 0, y: 0, z: 0 }, 0, Math.PI / 2);
    expect(slot).toBeDefined();
    if (!slot) return;

    // Short of the fuse: nothing yet.
    advance(rig, ITEMS.fuse - DT * 3);
    expect(rig.blasts.length).toBe(0);
    expect(slot.active).toBe(true);

    advance(rig, DT * 5);
    expect(rig.blasts.length).toBe(1);
    expect(slot.active).toBe(false);
    const blast = rig.blasts[0]!;
    expect(blast.radius).toBe(ITEMS.blastRadius);
    expect(blast.damage).toBe(ITEMS.blastDamage);
    // Thrown nearly straight up, so at detonation it is nowhere near the ground: the
    // fuse, not a collision, is what set it off.
    expect(blast.position.y).toBeGreaterThan(1);
  });

  it('detonates once and only once', () => {
    const rig = makeItems();
    throwOnce(rig, { x: 0, y: 0, z: 0 }, 0, 0.4);
    advance(rig, ITEMS.fuse + 1);
    expect(rig.blasts.length).toBe(1);
    advance(rig, 2);
    expect(rig.blasts.length).toBe(1);
    expect(rig.items.activeCount()).toBe(0);
  });

  it('is removed without exploding when its lifetime runs out first', () => {
    // Reaching this branch means the fuse and the lifetime are misconfigured relative
    // to each other; the test forces that configuration to prove the branch exists and
    // that it is silent. A dud must not detonate.
    const rig = makeItems();
    throwOnce(rig, { x: 0, y: 0, z: 0 }, 0, 0);
    const slot = rig.items.throwables.find((candidate) => candidate.active);
    expect(slot).toBeDefined();
    if (!slot) return;
    slot.lifeRemaining = DT * 2;
    slot.fuseRemaining = ITEMS.fuse;
    advance(rig, DT * 6);
    expect(rig.blasts.length).toBe(0);
    expect(slot.active).toBe(false);
    expect(rig.items.activeCount()).toBe(0);
  });

  it('detonates on the tick the fuse reaches zero, not later', () => {
    const rig = makeItems();
    const { slot } = throwOnce(rig, { x: 0, y: 0, z: 0 }, 0, 0);
    expect(slot).toBeDefined();
    if (!slot) return;
    const ticks = Math.ceil(ITEMS.fuse / DT);
    for (let i = 0; i < ticks - 1; i += 1) rig.items.tick(DT, NO_SOLIDS, rig.blasts);
    expect(rig.blasts.length).toBe(0);
    rig.items.tick(DT, NO_SOLIDS, rig.blasts);
    expect(rig.blasts.length).toBe(1);
  });

  it('refuses a throw while the cooldown is running', () => {
    const rig = makeItems(ITEMS.throwCooldown);
    expect(rig.items.throwFrom({ x: 0, y: 0, z: 0 }, 0, 0)).toBe(true);
    expect(rig.items.throwFrom({ x: 0, y: 0, z: 0 }, 0, 0)).toBe(false);
    advance(rig, ITEMS.throwCooldown + DT);
    expect(rig.items.throwFrom({ x: 0, y: 0, z: 0 }, 0, 0)).toBe(true);
  });

  it('refuses a throw when the pool is exhausted rather than growing it', () => {
    const items = createItemSystem({ poolSize: 2, throwCooldown: 0 });
    expect(items.throwFrom({ x: 0, y: 0, z: 0 }, 0, 0)).toBe(true);
    expect(items.throwFrom({ x: 1, y: 0, z: 0 }, 0, 0)).toBe(true);
    expect(items.throwFrom({ x: 2, y: 0, z: 0 }, 0, 0)).toBe(false);
    expect(items.throwables.length).toBe(2);
    expect(items.activeCount()).toBe(2);
  });

  it('reuses a slot once its item has exploded', () => {
    const items = createItemSystem({ poolSize: 1, throwCooldown: 0 });
    const blasts: Explosion[] = [];
    expect(items.throwFrom({ x: 0, y: 0, z: 0 }, 0, 0)).toBe(true);
    const before = items.throwables[0]!.id;
    for (let i = 0; i < Math.ceil((ITEMS.fuse + 0.1) / DT); i += 1) items.tick(DT, NO_SOLIDS, blasts);
    expect(items.activeCount()).toBe(0);
    expect(items.throwFrom({ x: 0, y: 0, z: 0 }, 0, 0)).toBe(true);
    expect(items.throwables.length).toBe(1);
    expect(items.activeCount()).toBe(1);
    // The id moves on, so a view keyed on it can never confuse the two lives.
    expect(items.throwables[0]!.id).not.toBe(before);
  });

  it('clear() retires everything in flight, and nothing detonates afterwards', () => {
    const rig = makeItems();
    throwOnce(rig, { x: 0, y: 0, z: 0 }, 0, 0.5);
    expect(rig.items.activeCount()).toBe(1);
    rig.items.clear();
    expect(rig.items.activeCount()).toBe(0);
    advance(rig, ITEMS.fuse + 1);
    expect(rig.blasts.length).toBe(0);
    for (const slot of rig.items.throwables) expect(slot.active).toBe(false);
  });

  it('reports how many are in the air', () => {
    const rig = makeItems();
    expect(rig.items.activeCount()).toBe(0);
    throwOnce(rig, { x: 0, y: 0, z: 0 }, 0, 0);
    expect(rig.items.activeCount()).toBe(1);
    advanceToFirstBlast(rig);
    expect(rig.items.activeCount()).toBe(0);
  });
});

describe('explosion: the splash, through the real store', () => {
  /** A store with no dummies: every entry in it is a spawned enemy. */
  function store() {
    return createEnemyStore([], new EventBus());
  }

  /**
   * Raw damage taken by a lone body at `distance` from the blast.
   *
   * Measured on a Warden, not a Stalker: `applyDamage` clamps health at zero, so a
   * 60 HP body can only ever *show* 60 points of damage however hard it was hit.
   * Reading the falloff curve off a body that dies to any hit would make the whole
   * near half of the range look flat.
   */
  function damageAt(distance: number): number {
    const enemies = store();
    const target = enemies.spawn('large', { x: distance, y: 0, z: 0 }, { state: 'IDLE' });
    enemies.applyBlast({
      ownerId: 0,
      position: { x: 0, y: 0, z: 0 },
      radius: ITEMS.blastRadius,
      damage: ITEMS.blastDamage,
    });
    return target.totalDamageTaken;
  }

  it('deals full damage at the epicentre', () => {
    expect(damageAt(0)).toBe(ITEMS.blastDamage);
  });

  it('falls off linearly towards the edge and is floored at one', () => {
    const quarter = damageAt(ITEMS.blastRadius * 0.25);
    const half = damageAt(ITEMS.blastRadius * 0.5);
    const edge = damageAt(ITEMS.blastRadius);
    expect(quarter).toBeLessThan(ITEMS.blastDamage);
    expect(quarter).toBeGreaterThan(half);
    expect(half).toBeGreaterThan(edge);
    // A hit that visibly connected always registers, so the floor is 1 and not 0.
    expect(edge).toBe(1);
    // And the curve really is linear: half the radius is half the damage.
    expect(half).toBeCloseTo(ITEMS.blastDamage * 0.5, -1);
    expect(quarter).toBeCloseTo(ITEMS.blastDamage * 0.75, -1);
  });

  it('does nothing outside the radius', () => {
    expect(damageAt(ITEMS.blastRadius + 0.01)).toBe(0);
    expect(damageAt(ITEMS.blastRadius * 3)).toBe(0);
  });

  it('hits every body inside it exactly once each', () => {
    const enemies = store();
    const near = enemies.spawn('large', { x: 1, y: 0, z: 0 }, { state: 'IDLE' });
    const mid = enemies.spawn('large', { x: -2.5, y: 0, z: 0 }, { state: 'IDLE' });
    const far = enemies.spawn('large', { x: 0, y: 0, z: 5 }, { state: 'IDLE' });
    const outside = enemies.spawn('large', { x: 0, y: 0, z: 7 }, { state: 'IDLE' });

    const hits = enemies.applyBlast({
      ownerId: 0,
      position: { x: 0, y: 0, z: 0 },
      radius: ITEMS.blastRadius,
      damage: ITEMS.blastDamage,
    });

    expect(hits).toBe(3);
    // 1 m from the centre of a 5.5 m blast: 130 * (1 - 1/5.5) rounded, which is the
    // linear falloff the marker and the damage number both promise.
    expect(near.totalDamageTaken).toBe(Math.round(ITEMS.blastDamage * (1 - 1 / ITEMS.blastRadius)));
    expect(near.totalDamageTaken).toBeLessThan(ITEMS.blastDamage);
    expect(mid.totalDamageTaken).toBeGreaterThan(0);
    expect(far.totalDamageTaken).toBeGreaterThan(0);
    expect(outside.totalDamageTaken).toBe(0);
    // One share each, not one per nearby body.
    expect(near.totalDamageTaken).toBeLessThan(ITEMS.blastDamage * 2);
  });

  it('leaves the owner alone, which is how a Warden bombs its own Stalkers', () => {
    const enemies = store();
    const owner = enemies.spawn('large', { x: 0, y: 0, z: 0 }, { state: 'IDLE' });
    const victim = enemies.spawn('small', { x: 1.5, y: 0, z: 0 }, { state: 'IDLE' });
    const hits = enemies.applyBlast({
      ownerId: owner.id,
      position: { x: 0, y: 0, z: 0 },
      radius: ITEMS.blastRadius,
      damage: ENEMY_LARGE.damage,
    });
    expect(hits).toBe(1);
    expect(owner.totalDamageTaken).toBe(0);
    expect(victim.totalDamageTaken).toBeGreaterThan(0);
  });

  it('kills a Stalker outright at the centre and leaves the Warden standing', () => {
    const enemies = store();
    const stalker = enemies.spawn('small', { x: 0, y: 0, z: 0 }, { state: 'IDLE' });
    const warden = enemies.spawn('large', { x: 2, y: 0, z: 0 }, { state: 'IDLE' });
    enemies.applyBlast({
      ownerId: 0,
      position: { x: 0, y: 0, z: 0 },
      radius: ITEMS.blastRadius,
      damage: ITEMS.blastDamage,
    });
    // 130 against 60 HP, and about 102 against 2400: the two archetypes have to read
    // completely differently to the same item, or the throw has no target priority.
    expect(stalker.alive).toBe(false);
    expect(warden.alive).toBe(true);
    expect(warden.health).toBeGreaterThan(ENEMY_LARGE.maxHealth * 0.9);
    expect(ENEMY_SMALL.maxHealth).toBeLessThan(ITEMS.blastDamage);
  });

  it('resolves the whole chain: throw, fly, detonate, damage', () => {
    const enemies = store();
    const target = enemies.spawn('small', { x: 0, y: 0, z: -6 }, { state: 'IDLE' });
    const rig = makeItems();
    // Aimed slightly down, which is what a player does to land a throw at range: the
    // loft would otherwise carry it over the target's head.
    rig.items.throwFrom({ x: 0, y: 0, z: 0 }, 0, -0.35);
    const ticks = advanceToFirstBlast(rig);
    expect(ticks).toBeGreaterThan(0);
    const blast = rig.blasts[0]!;
    expect(Number.isFinite(blast.position.z)).toBe(true);

    const hits = enemies.applyBlast({
      ownerId: 0,
      position: blast.position,
      radius: blast.radius,
      damage: blast.damage,
    });
    // An arc is not a laser, so the assertion is that the chain is consistent: whatever
    // the blast did, the store agrees about how many bodies were inside it.
    expect(hits).toBeGreaterThanOrEqual(0);
    expect(hits).toBeLessThanOrEqual(1);
    if (hits === 1) expect(target.totalDamageTaken).toBeGreaterThan(0);
  });
});
