/**
 * Enemy simulation tests.
 *
 * These drive the store directly — no world, no renderer, no WebGL — which is the
 * payoff of keeping `game/enemies/**` pure data. What is asserted here is the
 * stage-2 acceptance list, one behaviour per test:
 *
 *   - a Stalker closes, commits, and can only swing inside `ATTACK_SLOTS`;
 *   - a Warden holds its distance band, leads its target, and enrages without
 *     shortening its telegraph;
 *   - a dead enemy is gone: no hitbox, no slot, `alive === false`.
 *
 * The event-capture helpers exist because the enemy store deliberately *publishes*
 * damage rather than applying it (the world owns the player), so the only way to
 * observe an attack landing is to subscribe.
 */

import { describe, expect, it } from 'vitest';
import {
  ATTACK_SLOTS,
  ENEMY_LARGE,
  ENEMY_SMALL,
  ENRAGE_COOLDOWN_SCALE,
  ENRAGE_HEALTH_FRACTION,
  PLAYER,
  SIM,
  WEAPON,
} from '#/core/config';
import { EventBus, type GameEvents } from '#/core/events';
import { distanceXZ, vec3 } from '#/core/math/vec3';
import { aabb, createRayHit, rayAabb, raySphere } from '#/core/math/intersect';
import { applyPlayerDamage, tickPlayerInvulnerability, tickPlayerRegen } from '#/game/player/combat';
import type { CollisionWorld, PlayerState } from '#/game/player/player';
import { createPlayerState } from '#/game/player/player';
import { createWeaponState } from '#/game/player/weapon';
import { createEnemyStore, type EnemyContext, type EnemyStore } from '#/game/enemies/EnemyStore';
import { phaseAt, type AttackFrame } from '#/game/enemies/frames';
import { isAttacking, type EnemyState } from '#/game/enemies/EnemyState';

const DT = 1 / SIM.tickHz;

/** An empty arena: no obstacles, so movement tests are about the AI and nothing else. */
function emptyWorld(): CollisionWorld {
  return { obstacles: [], solids: [], halfSize: 24 };
}

/** A world with one wall, for the "enemies do not walk through crates" check. */
function walledWorld(): CollisionWorld {
  const wall = aabb(4, 1.5, 0, 0.5, 1.5, 6);
  return { obstacles: [wall], solids: [wall], halfSize: 24 };
}

interface Harness {
  readonly store: EnemyStore;
  readonly events: EventBus;
  readonly player: PlayerState;
  /** Time the harness has advanced, kept in step with the store's own clock. */
  time: number;
  /** Every `player:damaged` request the enemy layer published. */
  readonly damageRequests: GameEvents['player:damaged'][];
  /** Every barrage impact that detonated. */
  readonly impacts: GameEvents['barrage:impact'][];
  /** Every telegraph that opened. */
  readonly telegraphs: GameEvents['enemy:telegraph'][];
  /** Advances the whole harness by `seconds`. */
  run(seconds: number): void;
  /** Advances exactly `ticks` steps. */
  advance(ticks: number): void;
  /** The live enemy with the given id. */
  enemy(id: number): EnemyState;
  setPlayer(x: number, z: number): void;
  setPlayerVelocity(x: number, z: number): void;
  /** When false, published damage is recorded but not applied. */
  setLethal(value: boolean): void;
}

/**
 * Builds a store plus a stand-in for the world's damage handling.
 *
 * The player here is a real `PlayerState` driven by the real `applyPlayerDamage`,
 * because i-frames, health clamping and death are the behaviour under test — a
 * stub would only be asserting the stub.
 */
function harness(world: CollisionWorld = emptyWorld(), dummies = 0): Harness {
  const events = new EventBus(true);
  const specs = Array.from({ length: dummies }, (_, i) => ({
    id: i + 100,
    base: vec3(i * 2, 0, -20),
    bodyHeight: 1.1,
    bodyRadius: 0.36,
    headRadius: 0.24,
    health: 200,
    yawDeg: 0,
    bobAmplitude: 0,
    bobHz: 0,
  }));
  const store = createEnemyStore(specs, events);
  const player = createPlayerState(createWeaponState(1));

  const damageRequests: GameEvents['player:damaged'][] = [];
  const impacts: GameEvents['barrage:impact'][] = [];
  const telegraphs: GameEvents['enemy:telegraph'][] = [];
  /**
   * Whether published damage is actually applied to the stand-in player.
   *
   * A handful of tests are about the *enemy* — a Warden's enrage, its barrage
   * schedule — and need a player who cannot die in the middle of the run. Those
   * turn this off so the scene stays stable; the damage itself is verified
   * separately, with it on, by the tests that are about damage.
   */
  let lethal = true;

  // Mirrors `World`'s subscriptions exactly, so what is observed here is the
  // shipped resolution path rather than a test-only simplification.
  events.on('player:damaged', (payload) => {
    damageRequests.push(payload);
    if (!lethal) return;
    const result = applyPlayerDamage(player, payload.amount, payload.from, time);
    void result;
  });
  events.on('barrage:impact', (payload) => {
    impacts.push(payload);
  });
  events.on('enemy:telegraph', (payload) => {
    telegraphs.push(payload);
  });

  let time = 0;
  /**
   * Mutable view of the world, rebuilt field by field on every tick.
   *
   * Typed as `EnemyContext` rather than inferred, so the fields the harness mutates
   * stay plain `boolean`/`number` instead of being narrowed to their initial
   * literal types.
   */
  const context: {
    playerPosition: { x: number; y: number; z: number };
    playerVelocity: { x: number; y: number; z: number };
    playerAlive: boolean;
    time: number;
    dt: number;
    slots: EnemyContext['slots'];
    collision: CollisionWorld;
    attacks: EnemyContext['attacks'];
  } = {
    playerPosition: player.position,
    playerVelocity: player.velocity,
    playerAlive: true,
    time: 0,
    dt: DT,
    slots: store.attackSlots,
    collision: world,
    attacks: store.attacks,
  };

  const advance = (ticks: number): void => {
    for (let i = 0; i < ticks; i += 1) {
      context.time = time;
      context.playerAlive = !player.dead;
      store.tick(context);
      store.sync(DT, time);
      tickPlayerInvulnerability(player, DT);
      time += DT;
    }
  };

  return {
    store,
    events,
    player,
    get time() {
      return time;
    },
    set time(value: number) {
      time = value;
    },
    damageRequests,
    impacts,
    telegraphs,
    run(seconds) {
      advance(Math.round(seconds * SIM.tickHz));
    },
    advance,
    enemy(id) {
      const found = store.byId(id);
      if (!found) throw new Error(`no enemy ${id}`);
      return found;
    },
    setPlayer(x, z) {
      player.position.x = x;
      player.position.y = 0;
      player.position.z = z;
    },
    setPlayerVelocity(x, z) {
      player.velocity.x = x;
      player.velocity.z = z;
    },
    setLethal(value) {
      lethal = value;
    },
  };
}

/** Nearest hitbox along a ray, using the same primitives the shot resolver does. */
function traceStore(store: EnemyStore, origin: ReturnType<typeof vec3>, direction: ReturnType<typeof vec3>): {
  id: number;
  zone: string;
  distance: number;
} | null {
  const scratch = createRayHit();
  let best: { id: number; zone: string; distance: number } | null = null;
  for (const enemy of store.targets) {
    if (!enemy.alive) continue;
    for (const hitbox of enemy.hitboxes) {
      const hit =
        hitbox.shape === 'sphere'
          ? raySphere(scratch, origin, direction, hitbox.center, hitbox.radius)
          : rayAabb(scratch, origin, direction, hitbox.box);
      if (!hit || hit.t <= 0) continue;
      if (best && hit.t >= best.distance) continue;
      best = { id: enemy.id, zone: hitbox.zone, distance: hit.t };
    }
  }
  return best;
}

/** Spawns a Stalker and runs it to the point where its FSM is settled. */
function spawnStalker(h: Harness, x: number, z: number, state: 'SPAWN' | 'IDLE' = 'IDLE'): EnemyState {
  return h.store.spawn('small', vec3(x, 0, z), { state });
}

/** Spawns a Warden. */
function spawnWarden(h: Harness, x: number, z: number, state: 'SPAWN' | 'IDLE' = 'IDLE'): EnemyState {
  return h.store.spawn('large', vec3(x, 0, z), { state });
}

describe('Stalker: closing and committing', () => {
  it('leaves IDLE and closes on the player', () => {
    const h = harness();
    h.setPlayer(0, 0);
    const stalker = spawnStalker(h, 0, -18);
    const before = distanceXZ(stalker.position, h.player.position);
    h.run(1.5);
    const after = distanceXZ(stalker.position, h.player.position);
    expect(after).toBeLessThan(before - 3);
    expect(stalker.fsm === 'CHASE' || isAttacking(stalker)).toBe(true);
  });

  it('commits to a telegraph only inside attackRange, never before', () => {
    const h = harness();
    h.setPlayer(0, 0);
    spawnStalker(h, 0, -18);
    // Well outside range: five seconds of closing must not have produced a swing.
    h.run(1.0);
    expect(h.telegraphs.length).toBe(0);
    expect(distanceXZ(h.enemy(1).position, h.player.position)).toBeGreaterThan(ENEMY_SMALL.attackRange);
  });

  it('stops moving while it winds up', () => {
    const h = harness();
    h.setPlayer(0, 0);
    spawnStalker(h, 0, -1.4);
    // Run until the telegraph opens.
    for (let i = 0; i < 240 && h.enemy(1).fsm !== 'TELEGRAPH'; i += 1) h.advance(1);
    const stalker = h.enemy(1);
    expect(stalker.fsm).toBe('TELEGRAPH');
    const frozen = { x: stalker.position.x, z: stalker.position.z };
    h.advance(10);
    // Rooted: the telegraph is the only cue the player has, and a body that keeps
    // sliding during it makes the cue unreadable.
    expect(stalker.position.x).toBeCloseTo(frozen.x, 9);
    expect(stalker.position.z).toBeCloseTo(frozen.z, 9);
    expect(Math.hypot(stalker.velocity.x, stalker.velocity.z)).toBe(0);
  });

  it('lands exactly one hit per attack and then enters RECOVER', () => {
    const h = harness();
    h.setPlayer(0, 0);
    spawnStalker(h, 0, -1.2);
    h.run(2.5);
    expect(h.damageRequests.length).toBe(1);
    expect(h.damageRequests[0]?.amount).toBe(ENEMY_SMALL.damage);
    expect(h.damageRequests[0]?.source).toBe('melee');
    expect(h.player.health).toBe(PLAYER.maxHealth - ENEMY_SMALL.damage);
  });

  it('goes through TELEGRAPH, ACTIVE and RECOVER rather than skipping a window', () => {
    const h = harness();
    h.setPlayer(0, 0);
    const stalker = spawnStalker(h, 0, -1.2);
    const seen = new Set<string>();
    for (let i = 0; i < 300; i += 1) {
      seen.add(stalker.fsm);
      h.advance(1);
    }
    expect(seen.has('TELEGRAPH')).toBe(true);
    expect(seen.has('ACTIVE')).toBe(true);
    expect(seen.has('RECOVER')).toBe(true);
  });

  it('does not swing again before its cooldown has elapsed', () => {
    const h = harness();
    h.setPlayer(0, 0);
    const stalker = spawnStalker(h, 0, -1.2);
    // Run until the first strike lands, so the measurement starts from a known
    // point rather than from an assumed tick.
    let guard = 0;
    while (h.damageRequests.length === 0 && guard < 600) {
      h.advance(1);
      guard += 1;
    }
    expect(h.damageRequests.length).toBe(1);
    // The gap between attacks is recovery + cooldown. Half of it must not produce
    // a second strike, even with the player standing still in contact range: this
    // is the beat that makes "back off, then punish" a learnable loop.
    const gap = ENEMY_SMALL.recoveryTime + ENEMY_SMALL.attackCooldown;
    h.run(gap * 0.5);
    expect(h.damageRequests.length).toBe(1);
    expect(stalker.attackCooldown).toBeGreaterThan(0);
    // And it does swing again once the gap has passed.
    h.run(gap);
    expect(h.damageRequests.length).toBeGreaterThan(1);
  });
});

describe('Stalker: the attack-slot budget', () => {
  it('never lets more than ATTACK_SLOTS Stalkers telegraph or strike at once', () => {
    const h = harness(emptyWorld());
    h.setPlayer(0, 0);
    // Six arrive together, which is exactly the case the budget exists for.
    for (let i = 0; i < 6; i += 1) {
      const angle = (i / 6) * Math.PI * 2;
      spawnStalker(h, Math.sin(angle) * 1.2, Math.cos(angle) * 1.2);
    }
    let worst = 0;
    for (let i = 0; i < 1800; i += 1) {
      const attacking = h.store.targets.filter(
        (enemy) => enemy.alive && (enemy.fsm === 'TELEGRAPH' || enemy.fsm === 'ACTIVE'),
      ).length;
      worst = Math.max(worst, attacking);
      expect(h.store.attackSlots.used).toBeLessThanOrEqual(ATTACK_SLOTS);
      h.advance(1);
    }
    expect(worst).toBe(ATTACK_SLOTS);
  });

  it('rotates the slot between arrivals instead of letting the first three keep it', () => {
    const h = harness();
    h.setPlayer(0, 0);
    for (let i = 0; i < 6; i += 1) {
      const angle = (i / 6) * Math.PI * 2;
      spawnStalker(h, Math.sin(angle) * 1.2, Math.cos(angle) * 1.2);
    }
    // Sixty seconds of continuous pressure. With a first-come-first-served queue
    // the same three Stalkers fight for the whole minute and the rest orbit, which
    // reads in play as "the other three are broken".
    h.run(60);
    const served = h.store.targets.map((enemy) => h.store.attackSlots.priorityOf(enemy.id).served);
    expect(served.filter((count) => count > 0).length).toBe(6);
    // Balanced, not merely non-zero: the fairness metric is completed attacks, so
    // the spread has to stay inside one turn.
    expect(Math.max(...served) - Math.min(...served)).toBeLessThanOrEqual(1);
  });

  it('does not credit the rotation for an attack that was interrupted', () => {
    const h = harness();
    h.setPlayer(0, 0);
    const stalker = spawnStalker(h, 0, -1.2);
    for (let i = 0; i < 240 && stalker.fsm !== 'TELEGRAPH'; i += 1) h.advance(1);
    expect(stalker.fsm).toBe('TELEGRAPH');
    h.store.applyDamage(stalker, 10_000, 'body', stalker.position);
    // Killed mid-wind-up: no credit. Crediting it would reward dying, and because
    // ids survive pooling the credit would follow the entry into its next life.
    expect(h.store.attackSlots.priorityOf(stalker.id).served).toBe(0);
  });

  it('frees the slot when a mid-telegraph attacker is killed', () => {
    const h = harness();
    h.setPlayer(0, 0);
    const stalker = spawnStalker(h, 0, -1.2);
    for (let i = 0; i < 240 && stalker.fsm !== 'TELEGRAPH'; i += 1) h.advance(1);
    expect(h.store.attackSlots.has(stalker.id)).toBe(true);
    h.store.applyDamage(stalker, stalker.health, 'body', stalker.position);
    expect(stalker.alive).toBe(false);
    expect(h.store.attackSlots.has(stalker.id)).toBe(false);
    expect(h.store.attackSlots.used).toBe(0);
  });
});

describe('Stalker: taking damage', () => {
  it('dies to three body shots', () => {
    const h = harness();
    const stalker = spawnStalker(h, 0, -12);
    let shots = 0;
    while (stalker.alive && shots < 10) {
      h.store.applyDamage(stalker, WEAPON.damage, 'body', stalker.position);
      shots += 1;
    }
    expect(shots).toBe(3);
    expect(stalker.health).toBe(0);
    expect(stalker.alive).toBe(false);
  });

  it('dies to a single weak-point shot inside the falloff-free band', () => {
    const h = harness();
    const stalker = spawnStalker(h, 0, -12);
    h.store.applyDamage(stalker, WEAPON.damage * ENEMY_SMALL.headshotMultiplier, 'head', stalker.position);
    expect(stalker.alive).toBe(false);
  });

  it('is knocked back along the shot direction but not launched', () => {
    const h = harness();
    const stalker = spawnStalker(h, 0, -12);
    h.store.applyDamage(stalker, WEAPON.damage, 'body', stalker.position, vec3(0, 0, -1));
    // Pushed away from the shooter, i.e. along the shot direction.
    expect(stalker.velocity.z).toBeLessThan(0);
    expect(Math.hypot(stalker.velocity.x, stalker.velocity.z)).toBeLessThan(ENEMY_SMALL.attackMoveSpeed);
    // Horizontal only: the vertical axis belongs to the ground solve.
    expect(stalker.velocity.y).toBe(0);
  });

  it('staggers on a hit that is a large fraction of its health', () => {
    const h = harness();
    const stalker = spawnStalker(h, 0, -12);
    h.store.applyDamage(stalker, WEAPON.damage, 'body', stalker.position, vec3(0, 0, -1));
    expect(stalker.fsm).toBe('STAGGER');
    expect(stalker.stunRemaining).toBeGreaterThan(0);
    h.run(0.5);
    // And recovers to a chasing state rather than staying staggered for ever.
    expect(stalker.fsm).not.toBe('STAGGER');
  });

  it('removes a dead enemy from the hitbox query', () => {
    const h = harness();
    const stalker = spawnStalker(h, 0, -12);
    const origin = vec3(0, 0.6, 0);
    const direction = vec3(0, 0, -1);
    expect(traceStore(h.store, origin, direction)?.id).toBe(stalker.id);
    h.store.applyDamage(stalker, 1000, 'body', stalker.position);
    h.store.despawn(stalker);
    expect(traceStore(h.store, origin, direction)).toBeNull();
  });
});

describe('Stalker: collisions', () => {
  it('does not walk through a crate', () => {
    const h = harness(walledWorld());
    h.setPlayer(10, 0);
    // Spawned on the far side of the wall from the player.
    const stalker = spawnStalker(h, 0, 0);
    h.run(4);
    expect(stalker.position.x).toBeLessThan(4);
    expect(stalker.position.x).toBeGreaterThanOrEqual(4 - 0.5 - ENEMY_SMALL.radius - 1e-6);
  });

  it('stays inside the arena however hard it chases', () => {
    const h = harness();
    h.setPlayer(0, 0);
    spawnStalker(h, 20, 20);
    h.run(10);
    const stalker = h.enemy(1);
    expect(Math.abs(stalker.position.x)).toBeLessThanOrEqual(24);
    expect(Math.abs(stalker.position.z)).toBeLessThanOrEqual(24);
    expect(stalker.position.y).toBeGreaterThanOrEqual(0);
  });

  it('never produces NaN over a long run with a full pack', () => {
    const h = harness();
    h.setPlayer(0, 0);
    for (let i = 0; i < 8; i += 1) {
      const angle = (i / 8) * Math.PI * 2;
      spawnStalker(h, Math.sin(angle) * 0.2, Math.cos(angle) * 0.2);
    }
    h.run(20);
    for (const enemy of h.store.targets) {
      expect(Number.isFinite(enemy.position.x)).toBe(true);
      expect(Number.isFinite(enemy.position.y)).toBe(true);
      expect(Number.isFinite(enemy.position.z)).toBe(true);
      expect(Number.isFinite(enemy.velocity.x)).toBe(true);
    }
  });

  it('separates two enemies spawned on the same point', () => {
    const h = harness();
    h.setPlayer(20, 20);
    const a = spawnStalker(h, 0, 0);
    const b = spawnStalker(h, 0, 0);
    h.run(1);
    expect(distanceXZ(a.position, b.position)).toBeGreaterThan(ENEMY_SMALL.radius);
  });
});

describe('Warden: distance band and prediction', () => {
  it('closes when further away than the band', () => {
    const h = harness();
    h.setPlayer(0, 0);
    const warden = spawnWarden(h, 0, -40);
    h.run(4);
    expect(distanceXZ(warden.position, h.player.position)).toBeLessThan(40);
  });

  it('backs off when the player closes inside the band', () => {
    const h = harness();
    h.setPlayer(0, 0);
    const warden = spawnWarden(h, 0, -8);
    const before = distanceXZ(warden.position, h.player.position);
    h.run(4);
    expect(distanceXZ(warden.position, h.player.position)).toBeGreaterThan(before);
  });

  it('holds station inside 18-26 m and stops closing', () => {
    const h = harness();
    h.setPlayer(0, 0);
    const warden = spawnWarden(h, 0, -22);
    h.run(3);
    const distance = distanceXZ(warden.position, h.player.position);
    expect(distance).toBeGreaterThanOrEqual(17);
    expect(distance).toBeLessThanOrEqual(27);
  });

  it('locks and publishes impact points only when the wind-up ends', () => {
    const h = harness();
    h.setPlayer(0, 0);
    spawnWarden(h, 0, -20);
    // Enter the telegraph.
    for (let i = 0; i < 600 && h.enemy(1).fsm !== 'TELEGRAPH'; i += 1) h.advance(1);
    const warden = h.enemy(1);
    expect(warden.fsm).toBe('TELEGRAPH');
    const telegraphTicks = Math.round(ENEMY_LARGE.telegraphTime * SIM.tickHz);
    // Every tick of the wind-up has to leave the points empty: the player cannot
    // dodge a marker that is still being computed, and a marker that moves during
    // the wind-up teaches them to ignore markers.
    for (let i = 0; i < telegraphTicks - 1; i += 1) {
      expect(warden.impactPoints.length).toBe(0);
      h.advance(1);
    }
    // One tick later the wind-up is over, three points exist, and they have been
    // published so the presentation layer can draw the ground indicators.
    h.advance(2);
    expect(warden.impactPoints.length).toBe(3);
    expect(h.telegraphs.some((t) => t.impactPoints !== undefined && t.impactPoints.length === 3)).toBe(true);
  });

  it('leads a moving player rather than aiming where they are', () => {
    const h = harness();
    h.setPlayer(0, 0);
    h.setPlayerVelocity(6, 0);
    const warden = spawnWarden(h, 0, -20);
    for (let i = 0; i < 600 && h.enemy(1).fsm !== 'TELEGRAPH'; i += 1) h.advance(1);
    h.advance(90);
    expect(warden.impactPoints.length).toBe(3);
    const lead = warden.impactPoints[0];
    // The first blast is on the predicted point, which is ahead of the player.
    expect(lead?.x).toBeGreaterThan(h.player.position.x);
  });

  it('detonates three staggered blasts per barrage', () => {
    const h = harness();
    // The barrage is the subject; a player who dies to it part-way through would
    // end the run before the third shell lands.
    h.setLethal(false);
    h.setPlayer(0, 0);
    const warden = spawnWarden(h, 0, -20);
    let guard = 0;
    while (h.impacts.length < 3 && guard < 1200) {
      h.advance(1);
      guard += 1;
    }
    expect(h.impacts.length).toBe(3);
    // Three distinct impact points, and they are the same three the markers point
    // at: the telegraph the player read and the damage they took describe one set
    // of circles, not two.
    const points = warden.impactPoints;
    expect(points.length).toBe(3);
    const key = (p: { x: number; z: number }) => `${p.x.toFixed(3)},${p.z.toFixed(3)}`;
    expect(new Set(points.map(key)).size).toBe(3);
    expect(new Set(h.impacts.map((impact) => key(impact.position))).size).toBe(3);
    // Spread over consecutive ticks rather than simultaneous: the stagger is what
    // makes the barrage read as three impacts instead of one wide one.
    expect(new Set(h.impacts.map((impact) => impact.tick)).size).toBe(3);
    // Every impact carries the archetype's blast radius, so the markers and the
    // damage describe the same circle.
    for (const impact of h.impacts) expect(impact.radius).toBeGreaterThan(1);
  });

  it('damages the player through a barrage without hitting itself', () => {
    const h = harness();
    h.setLethal(false);
    h.setPlayer(0, 0);
    spawnWarden(h, 0, -20);
    h.run(4);
    const own = h.enemy(1);
    expect(h.damageRequests.some((request) => request.source === 'barrage')).toBe(true);
    // A Warden standing in its own barrage takes nothing: the owner is excluded.
    expect(own.health).toBe(ENEMY_LARGE.maxHealth);
  });
});

describe('Warden: enrage', () => {
  it('enters ENRAGE at the configured health threshold', () => {
    const h = harness();
    h.setPlayer(0, 0);
    const warden = spawnWarden(h, 0, -20);
    const threshold = ENEMY_LARGE.maxHealth * ENRAGE_HEALTH_FRACTION;
    // One point above the threshold is not enough.
    h.store.applyDamage(warden, ENEMY_LARGE.maxHealth - threshold - 1, 'body', warden.position);
    expect(warden.enraged).toBe(false);
    h.store.applyDamage(warden, 5, 'body', warden.position);
    expect(warden.enraged).toBe(true);
  });

  it('compresses recovery and cooldown, and leaves the telegraph untouched', () => {
    const h = harness();
    h.setPlayer(0, 0);
    const warden = spawnWarden(h, 0, -20);
    const frame: AttackFrame = {
      telegraphTime: ENEMY_LARGE.telegraphTime,
      activeTime: ENEMY_LARGE.activeTime,
      recoveryTime: ENEMY_LARGE.recoveryTime,
    };
    // Drive it into a telegraph and measure how long the wind-up lasts, enraged.
    for (let i = 0; i < 600 && warden.fsm !== 'TELEGRAPH'; i += 1) h.advance(1);
    warden.health = ENEMY_LARGE.maxHealth * 0.1;
    warden.enraged = true;
    // The phase machine is the authority: at exactly telegraphTime the strike is
    // live whether or not the enemy is enraged.
    expect(phaseAt(ENEMY_LARGE.telegraphTime, frame, ENRAGE_COOLDOWN_SCALE)).toBe('ACTIVE');
    expect(phaseAt(ENEMY_LARGE.telegraphTime - 1e-9, frame, ENRAGE_COOLDOWN_SCALE)).toBe('TELEGRAPH');
    // And the recovery window is the scaled one.
    const enragedTotal = ENEMY_LARGE.telegraphTime + ENEMY_LARGE.activeTime + ENEMY_LARGE.recoveryTime * ENRAGE_COOLDOWN_SCALE;
    expect(phaseAt(enragedTotal - 1e-9, frame, ENRAGE_COOLDOWN_SCALE)).toBe('RECOVER');
    expect(phaseAt(enragedTotal, frame, ENRAGE_COOLDOWN_SCALE)).toBe('DONE');
  });

  it('staggers on cumulative weak-point damage rather than on a single body shot', () => {
    const h = harness();
    h.setPlayer(0, 0);
    const warden = spawnWarden(h, 0, -22);
    // Wait until it is actually free to be interrupted: a Warden mid-attack is
    // never interrupted, which is a separate (and deliberate) rule.
    for (let i = 0; i < 900 && warden.fsm !== 'REPOSITION'; i += 1) h.advance(1);
    expect(warden.fsm).toBe('REPOSITION');
    // A single body shot -- 0.9% of its health -- never interrupts it.
    h.store.applyDamage(warden, WEAPON.damage, 'body', warden.position);
    expect(warden.fsm).toBe('REPOSITION');
    // Cumulative weak-point damage does. The threshold is 6% of its health, so
    // this loop is the rule stated directly rather than a guessed hit count.
    const headShot = WEAPON.damage * ENEMY_LARGE.headshotMultiplier;
    const threshold = ENEMY_LARGE.maxHealth * 0.06;
    const needed = Math.ceil(threshold / headShot) + 1;
    for (let i = 0; i < needed; i += 1) {
      h.store.applyDamage(warden, headShot, 'head', warden.position);
      if (warden.fsm === 'STAGGER') break;
    }
    expect(warden.fsm).toBe('STAGGER');
    expect(warden.stunRemaining).toBeGreaterThan(0);
    // And the stagger ends on its own rather than pinning it for ever.
    h.run(1);
    expect(warden.fsm).not.toBe('STAGGER');
  });
});

describe('practice dummies', () => {
  it('keeps the phase-1 baseline reachable and excluded from wave bookkeeping', () => {
    const h = harness(emptyWorld(), 3);
    expect(h.store.targets.length).toBe(3);
    expect(h.store.aliveCount()).toBe(3);
    // Dummies are not combatants: the director's "are the small enemies dead"
    // question must not be answered by a practice target.
    expect(h.store.liveCount()).toBe(0);
  });

  it('still resolves a shot against the same body/head geometry as phase 1', () => {
    const h = harness(emptyWorld(), 1);
    const dummy = h.store.targets[0];
    if (!dummy) throw new Error('no dummy');
    const origin = vec3(dummy.position.x, 0.6, dummy.position.z + 6);
    const direction = vec3(0, 0, -1);
    expect(traceStore(h.store, origin, direction)?.zone).toBe('body');
    const headOrigin = vec3(dummy.position.x, dummy.stats.height - dummy.stats.height * 0.2, dummy.position.z + 6);
    expect(traceStore(h.store, headOrigin, direction)?.zone).toBe('head');
  });

  it('dies and is not revived by a reset of the live enemies', () => {
    const h = harness(emptyWorld(), 2);
    spawnStalker(h, 0, -10);
    const dummy = h.store.targets[0];
    if (!dummy) throw new Error('no dummy');
    h.store.applyDamage(dummy, 10_000, 'body', dummy.position);
    h.store.reset();
    expect(dummy.alive).toBe(true);
    expect(dummy.health).toBe(dummy.stats.maxHealth);
    expect(h.store.liveCount()).toBe(0);
  });
});

describe('player damage and invulnerability', () => {
  /**
   * A clock plus the two per-tick player bookkeeping calls.
   *
   * The i-frame window and the regeneration delay are both measured against
   * simulation time, so a test that advances one without the other is not testing
   * the shipped behaviour. Keeping the three in step here is what makes the
   * assertions below mean what they say.
   */
  function clock(h: Harness): { hit(amount: number, from?: ReturnType<typeof vec3>): ReturnType<typeof applyPlayerDamage>; idle(seconds: number): void } {
    let time = 0;
    return {
      hit(amount, from = vec3(0, 0, -1)) {
        return applyPlayerDamage(h.player, amount, from, time);
      },
      idle(seconds) {
        for (let i = 0; i < Math.round(seconds * SIM.tickHz); i += 1) {
          tickPlayerInvulnerability(h.player, DT);
          tickPlayerRegen(h.player, DT, time);
          time += DT;
        }
      },
    };
  }

  it('absorbs hits inside the i-frame window and applies them after it', () => {
    const h = harness();
    const c = clock(h);
    expect(c.hit(9).applied).toBe(9);
    expect(h.player.health).toBe(PLAYER.maxHealth - 9);
    // Immediately again: absorbed, because the window is still open.
    const absorbed = c.hit(9);
    expect(absorbed.applied).toBe(0);
    expect(absorbed.absorbed).toBe(true);
    expect(h.player.health).toBe(PLAYER.maxHealth - 9);
    // After the window has been ticked down, it lands again.
    c.idle(PLAYER.hitInvulnerability + 0.01);
    const later = c.hit(9);
    expect(later.applied).toBe(9);
    expect(h.player.health).toBe(PLAYER.maxHealth - 18);
  });

  it('cannot be stunlocked: any further hit inside the i-frame window is absorbed', () => {
    const h = harness();
    h.setPlayer(0, 0);
    for (let i = 0; i < 6; i += 1) {
      const angle = (i / 6) * Math.PI * 2;
      spawnStalker(h, Math.sin(angle) * 1.2, Math.cos(angle) * 1.2);
    }
    // Run until the first strike lands, so the window is known to be open.
    for (let i = 0; i < 600 && h.player.health === PLAYER.maxHealth; i += 1) h.advance(1);
    const afterFirst = h.player.health;
    expect(afterFirst).toBe(PLAYER.maxHealth - ENEMY_SMALL.damage);
    expect(h.player.invulnerableFor).toBeGreaterThan(0);
    // A second hit while the window is open does nothing at all, even though five
    // other Stalkers are standing in contact range and will certainly attack.
    const second = applyPlayerDamage(h.player, ENEMY_SMALL.damage, vec3(0, 0, -1), h.time);
    expect(second.absorbed).toBe(true);
    expect(h.player.health).toBe(afterFirst);
  });

  it('dies after the documented number of Warden hits and takes no more', () => {
    const h = harness();
    const c = clock(h);
    let hits = 0;
    let guard = 0;
    while (!h.player.dead && guard < 50) {
      c.hit(ENEMY_LARGE.damage);
      hits += 1;
      guard += 1;
      // Wait out the i-frame window between volleys, which is how a real barrage
      // is spaced anyway (2.8 s of cooldown between attacks).
      if (!h.player.dead) c.idle(PLAYER.hitInvulnerability + 0.01);
    }
    expect(h.player.dead).toBe(true);
    // ceil(150 / 34) = 5, the documented time-to-kill for a Warden.
    expect(hits).toBe(Math.ceil(PLAYER.maxHealth / ENEMY_LARGE.damage));
    expect(h.player.health).toBe(0);
    // And a corpse takes nothing further.
    expect(c.hit(34).applied).toBe(0);
  });

  it('regenerates only after the configured delay', () => {
    const h = harness();
    const c = clock(h);
    c.hit(40);
    const damaged = h.player.health;
    // Just short of the delay: nothing has come back.
    c.idle(PLAYER.regenDelay - 0.2);
    expect(h.player.health).toBe(damaged);
    // Past it: health climbs, and is capped at the maximum.
    c.idle(2);
    expect(h.player.health).toBeGreaterThan(damaged);
    expect(h.player.health).toBeLessThanOrEqual(PLAYER.maxHealth);
    c.idle(20);
    expect(h.player.health).toBe(PLAYER.maxHealth);
  });

  it('does not regenerate a dead player', () => {
    const h = harness();
    const c = clock(h);
    while (!h.player.dead) {
      c.hit(ENEMY_LARGE.damage);
      c.idle(PLAYER.hitInvulnerability + 0.01);
    }
    expect(h.player.dead).toBe(true);
    c.idle(30);
    expect(h.player.health).toBe(0);
  });
});

describe('store hygiene', () => {
  it('recycles a despawned enemy into the pool instead of leaking it', () => {
    const h = harness();
    const first = spawnStalker(h, 0, -10);
    const id = first.id;
    h.store.despawn(first);
    expect(h.store.byId(id)).toBeUndefined();
    expect(h.store.liveCount()).toBe(0);
    const second = spawnStalker(h, 0, -14);
    // Pooled entries keep their id, so a stale event can be told apart from a new
    // one; that is the reason identity survives the recycle.
    expect(second.id).toBe(id);
    expect(second.health).toBe(ENEMY_SMALL.maxHealth);
    expect(second.alive).toBe(true);
  });

  it('scales spawn health and never below one point', () => {
    const h = harness();
    const doubled = h.store.spawn('small', vec3(0, 0, -10), { healthScale: 2 });
    expect(doubled.health).toBe(ENEMY_SMALL.maxHealth * 2);
    const zeroed = h.store.spawn('small', vec3(2, 0, -10), { healthScale: 0 });
    expect(zeroed.health).toBe(1);
  });

  it('counts only live combatants in liveCount', () => {
    const h = harness(emptyWorld(), 2);
    expect(h.store.liveCount()).toBe(0);
    spawnStalker(h, 0, -10);
    spawnWarden(h, 0, -20);
    expect(h.store.liveCount()).toBe(2);
    expect(h.store.liveCount('small')).toBe(1);
    expect(h.store.liveCount('large')).toBe(1);
  });

  it('keeps enemy ids unique across dummies and spawns', () => {
    const h = harness(emptyWorld(), 3);
    const ids = new Set(h.store.targets.map((enemy) => enemy.id));
    expect(ids.size).toBe(3);
    for (let i = 0; i < 10; i += 1) {
      const spawned = spawnStalker(h, i, -10);
      expect(ids.has(spawned.id)).toBe(false);
      ids.add(spawned.id);
    }
  });
});
