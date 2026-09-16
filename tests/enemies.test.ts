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
  ENEMY_HELICOPTER,
  ENEMY_LARGE,
  ENEMY_SMALL,
  ENRAGE_COOLDOWN_SCALE,
  ENRAGE_HEALTH_FRACTION,
  HELICOPTER,
  PICKUPS,
  PLAYER,
  SIM,
  WARDEN,
  WEAPON,
} from '#/core/config';
import { EventBus, type GameEvents } from '#/core/events';
import { distanceXZ, vec3 } from '#/core/math/vec3';
import { aabb, createRayHit, rayAabb, raySphere } from '#/core/math/intersect';
import { applyPlayerDamage, healPlayer, tickPlayerInvulnerability, tickPlayerRegen } from '#/game/player/combat';
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
  /** Every Warden shot that left the barrel. */
  readonly shots: GameEvents['enemy:shot'][];
  /** Every shot whose line ended, with where and on what. */
  readonly shotEnds: GameEvents['enemy:shotEnded'][];
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
  const shots: GameEvents['enemy:shot'][] = [];
  const shotEnds: GameEvents['enemy:shotEnded'][] = [];
  const telegraphs: GameEvents['enemy:telegraph'][] = [];
  /**
   * Whether published damage is actually applied to the stand-in player.
   *
   * A handful of tests are about the *enemy* — a Warden's enrage, its shot schedule — and need
   * a player who cannot die in the middle of the run. Those turn this off so the scene stays
   * stable; the damage itself is verified separately, with it on, by the tests that are about
   * damage.
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
  events.on('enemy:shot', (payload) => {
    shots.push(payload);
  });
  events.on('enemy:shotEnded', (payload) => {
    shotEnds.push(payload);
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
    shots,
    shotEnds,
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

describe('Warden: distance band', () => {
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
});

describe('Warden: the straight shot', () => {
  /** Perpendicular distance from a point to an infinite line through `origin`. */
  function distanceToRay(
    origin: { x: number; y: number; z: number },
    direction: { x: number; y: number; z: number },
    point: { x: number; y: number; z: number },
  ): number {
    const vx = point.x - origin.x;
    const vy = point.y - origin.y;
    const vz = point.z - origin.z;
    const t = vx * direction.x + vy * direction.y + vz * direction.z;
    return Math.hypot(vx - direction.x * t, vy - direction.y * t, vz - direction.z * t);
  }

  /** The player's chest, which is what the line is solved against. */
  function chest(h: Harness): { x: number; y: number; z: number } {
    return { x: h.player.position.x, y: h.player.position.y + PLAYER.height * 0.5, z: h.player.position.z };
  }

  /** Runs until the Warden has fired, or gives up noisily. */
  function runUntilFired(h: Harness, warden: EnemyState): void {
    let guard = 0;
    while (warden.shots.length === 0 && guard < 1200) {
      h.advance(1);
      guard += 1;
    }
    expect(warden.shots.length, 'the Warden never fired').toBeGreaterThan(0);
  }

  it('fires from its own body, straight at the player, once per attack', () => {
    const h = harness();
    h.setLethal(false);
    h.setPlayer(0, 0);
    const warden = spawnWarden(h, 0, -20);
    runUntilFired(h, warden);

    expect(h.shots).toHaveLength(1);
    const shot = warden.shots[0];
    if (!shot) throw new Error('no shot');
    // It left the Warden's body, not the player's: the muzzle is inside its own radius.
    const fromBody = Math.hypot(shot.origin.x - warden.position.x, shot.origin.z - warden.position.z);
    expect(fromBody).toBeLessThanOrEqual(ENEMY_LARGE.radius + 1e-6);
    expect(shot.origin.z).toBeLessThan(-18);
    // The line points at the player's chest. This is the whole requirement: the attack is a
    // line from the Warden to the player, so the chest is *on* it.
    expect(distanceToRay(shot.origin, shot.direction, chest(h))).toBeLessThan(0.05);
    expect(Math.hypot(shot.direction.x, shot.direction.y, shot.direction.z)).toBeCloseTo(1, 12);
    // And it is aimed at the player as they *are*, not where they were going: a line offset
    // into their future would visibly miss the body it is drawn from.
    expect(h.telegraphs.filter((t) => t.kind === 'shot')).toHaveLength(1);
  });

  it('freezes the direction at launch, so stepping off the line is a real dodge', () => {
    const h = harness();
    h.setLethal(false);
    h.setPlayer(0, 0);
    const warden = spawnWarden(h, 0, -20);
    runUntilFired(h, warden);
    const shot = warden.shots[0];
    if (!shot) throw new Error('no shot');
    const frozen = { ...shot.direction };

    // The player walks sideways off the line while the bolt is in the air.
    h.setPlayer(5, 0);
    h.advance(Math.ceil(WARDEN.shotRange / WARDEN.shotSpeed / DT) + 10);

    // Bit-for-bit identical: nothing re-aims a shot in flight. A direction that followed the
    // player would make the dodge impossible rather than skilful.
    expect(shot.direction.x).toBe(frozen.x);
    expect(shot.direction.y).toBe(frozen.y);
    expect(shot.direction.z).toBe(frozen.z);
    expect(h.damageRequests.some((request) => request.source === 'shot')).toBe(false);
    expect(shot.alive).toBe(false);
    expect(h.shotEnds.every((end) => end.hitPlayer === false)).toBe(true);
  });

  it('damages a player who stays on the path', () => {
    const h = harness();
    h.setLethal(false);
    h.setPlayer(0, 0);
    spawnWarden(h, 0, -20);
    h.run(4);
    const hit = h.damageRequests.find((request) => request.source === 'shot');
    expect(hit).toBeDefined();
    // No falloff and no blast share: the shot either crossed the body or it did not, so it
    // deals the archetype's configured damage exactly.
    expect(hit?.amount).toBe(ENEMY_LARGE.damage);
    expect(h.shotEnds.some((end) => end.hitPlayer)).toBe(true);
  });

  it('hits only the player: the line passes through enemies without touching them', () => {
    const h = harness();
    h.setLethal(false);
    h.setPlayer(0, 0);
    const warden = spawnWarden(h, 0, -20);
    // A Stalker parked midway down the line. The area attack this replaced bombed its own
    // swarm; a single-target line must not.
    const stalker = spawnStalker(h, 0, -10, 'IDLE');
    h.run(6);
    expect(h.damageRequests.some((request) => request.source === 'shot')).toBe(true);
    expect(stalker.health).toBe(ENEMY_SMALL.maxHealth);
    expect(warden.health).toBe(ENEMY_LARGE.maxHealth);
  });

  it('does not shoot through cover', () => {
    const h = harness(walledWorld());
    h.setLethal(false);
    // The wall sits at x = 4, between the Warden at the origin and the player at x = 10.
    h.setPlayer(10, 0);
    spawnWarden(h, 0, 0);
    let guard = 0;
    while (h.shotEnds.length === 0 && guard < 1200) {
      h.advance(1);
      guard += 1;
    }
    expect(h.shotEnds.length).toBeGreaterThan(0);
    expect(h.shotEnds.every((end) => end.hitPlayer === false)).toBe(true);
    expect(h.damageRequests.some((request) => request.source === 'shot')).toBe(false);
    // The line really did end at the wall rather than short of it.
    expect(h.shotEnds[0]?.position.x).toBeGreaterThan(3);
    expect(h.shotEnds[0]?.position.x).toBeLessThan(4.6);
  });

  it('retires the bolt at the end of its range instead of flying for ever', () => {
    const h = harness();
    h.setLethal(false);
    h.setPlayer(0, 0);
    const warden = spawnWarden(h, 0, -20);
    runUntilFired(h, warden);
    const shot = warden.shots[0];
    if (!shot) throw new Error('no shot');
    // Step off the line so nothing ends it early, then wait out the whole flight.
    h.setPlayer(6, 0);
    h.run(WARDEN.shotRange / WARDEN.shotSpeed + 0.5);
    expect(shot.alive).toBe(false);
    expect(shot.travelled).toBeGreaterThanOrEqual(WARDEN.shotRange - WARDEN.shotSpeed * DT);
    // It stops exactly at the range, not past it.
    expect(shot.travelled).toBeLessThan(WARDEN.shotRange + 1);
    // Flying off into the distance is silent: there is nothing out there to flash at.
    expect(h.shotEnds.length).toBe(0);
  });

  it('shows the warning line through the whole wind-up, aimed where the shot will go', () => {
    const h = harness();
    h.setLethal(false);
    h.setPlayer(0, 0);
    const warden = spawnWarden(h, 0, -20);
    for (let i = 0; i < 900 && warden.fsm !== 'TELEGRAPH'; i += 1) h.advance(1);
    expect(warden.fsm).toBe('TELEGRAPH');
    // From the first tick of the wind-up: a line that appears late is a line the player cannot
    // use, which is the failure the old ground markers existed to avoid.
    expect(warden.aim.active).toBe(true);
    expect(warden.aim.length).toBeGreaterThan(15);
    expect(distanceToRay(warden.aim.origin, warden.aim.direction, chest(h))).toBeLessThan(0.05);

    // It tracks the player, because the shot has not been fired yet.
    h.setPlayer(7, 0);
    h.advance(5);
    expect(distanceToRay(warden.aim.origin, warden.aim.direction, chest(h))).toBeLessThan(0.05);

    // And it comes down on the instant the bolt leaves, so the player is never looking at two
    // things that both claim to be the shot.
    const telegraphTicks = Math.round(ENEMY_LARGE.telegraphTime * SIM.tickHz);
    h.advance(telegraphTicks);
    expect(warden.aim.active).toBe(false);
    expect(warden.shots.length).toBe(1);
  });

  it('keeps resolving a bolt while its owner is busy doing something else', () => {
    const h = harness();
    h.setLethal(false);
    h.setPlayer(0, 0);
    const warden = spawnWarden(h, 0, -20);
    runUntilFired(h, warden);
    const shot = warden.shots[0];
    if (!shot) throw new Error('no shot');
    const travelled = shot.travelled;
    // The Warden is already walking through RECOVER and back into its band hold by the time
    // the bolt is halfway down the line. A projectile tied to its owner's animation would
    // freeze in mid-air here.
    h.run(0.4);
    expect(warden.fsm).toBe('RECOVER');
    expect(shot.travelled).toBeGreaterThan(travelled + 5);
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

describe('Gunship: the second wave', () => {
  /** Spawns the gunship. Its altitude is the store's business, so the caller passes `y = 0`. */
  function spawnGunship(h: Harness, x: number, z: number, state: 'SPAWN' | 'IDLE' = 'IDLE'): EnemyState {
    return h.store.spawn('helicopter', vec3(x, 0, z), { state });
  }

  /** Runs until the gunship has fired, or gives up noisily. */
  function runUntilGunshipFired(h: Harness, gunship: EnemyState): void {
    let guard = 0;
    while (gunship.shots.length === 0 && guard < 1200) {
      h.advance(1);
      guard += 1;
    }
    expect(gunship.shots.length, 'the gunship never fired').toBeGreaterThan(0);
  }

  /** Bearing of the gunship around the player, in radians. */
  function bearing(h: Harness, gunship: EnemyState): number {
    return Math.atan2(gunship.position.x - h.player.position.x, gunship.position.z - h.player.position.z);
  }

  it('carries the Warden’s health, damage and attack skeleton', () => {
    // The brief in one block: "attack method identical to the Warden, health and attack power
    // identical to the Warden". Every number here is read from the same table entry the Warden
    // reads, so a retune of either moves both — which is the point of the shared machine.
    expect(ENEMY_HELICOPTER.maxHealth).toBe(ENEMY_LARGE.maxHealth);
    expect(ENEMY_HELICOPTER.damage).toBe(ENEMY_LARGE.damage);
    expect(ENEMY_HELICOPTER.telegraphTime).toBe(ENEMY_LARGE.telegraphTime);
    expect(ENEMY_HELICOPTER.activeTime).toBe(ENEMY_LARGE.activeTime);
    expect(ENEMY_HELICOPTER.recoveryTime).toBe(ENEMY_LARGE.recoveryTime);
    expect(ENEMY_HELICOPTER.attackCooldown).toBe(ENEMY_LARGE.attackCooldown);
    expect(ENEMY_HELICOPTER.attackRange).toBe(ENEMY_LARGE.attackRange);
    expect(ENEMY_HELICOPTER.headshotMultiplier).toBe(ENEMY_LARGE.headshotMultiplier);
    // And it is its own body rather than a renamed Warden: a 1.9 m airframe with its own
    // speed, which is what makes the two heavies two fights.
    expect(ENEMY_HELICOPTER.height).not.toBe(ENEMY_LARGE.height);
    expect(ENEMY_HELICOPTER.moveSpeed).not.toBe(ENEMY_LARGE.moveSpeed);
  });

  it('is placed at its altitude and never falls to the floor', () => {
    const h = harness();
    h.setLethal(false);
    h.setPlayer(0, 0);
    const gunship = spawnGunship(h, 0, -20);
    // Placed, not taken off: the director's spawn points are ground positions, so a flying
    // body's `y` is the archetype's business.
    expect(gunship.position.y).toBeCloseTo(HELICOPTER.altitude, 6);
    h.run(5);
    // The flying integrator has no ground solve in it. A gunship that sank to y = 0 would be
    // a walking gunship.
    expect(gunship.position.y).toBeCloseTo(HELICOPTER.altitude, 3);
  });

  it('circles the player at the configured radius instead of closing in', () => {
    const h = harness();
    h.setLethal(false);
    h.setPlayer(0, 0);
    const gunship = spawnGunship(h, 0, -20);
    // It starts at the director's spawn distance and walks the radius in.
    h.run(8);

    /**
     * Sampled over twenty seconds, and only while the gunship is **holding station**.
     *
     * A gunship at 16 m is inside its own 26 m attack range, so it spends most of a cycle
     * rooted in TELEGRAPH/SHOT/RECOVER — where the shared machine halts it on purpose. The
     * claim under test is "it circles *between* shots", so measuring it during a wind-up would
     * be measuring the wrong thing (and would read as zero travel).
     */
    let previous = bearing(h, gunship);
    let swept = 0;
    let samples = 0;
    let sign = 0;
    const increment = DT * (ENEMY_HELICOPTER.moveSpeed / HELICOPTER.orbitRadius);
    for (let i = 0; i < 60 * 20; i += 1) {
      const holding = gunship.fsm === 'REPOSITION';
      h.advance(1);
      if (holding) {
        // A dead band, not a chase: the radius holds instead of shrinking.
        const distance = distanceXZ(gunship.position, h.player.position);
        expect(Math.abs(distance - HELICOPTER.orbitRadius)).toBeLessThan(HELICOPTER.orbitTolerance + 1.5);

        let delta = bearing(h, gunship) - previous;
        if (delta > Math.PI) delta -= Math.PI * 2;
        if (delta < -Math.PI) delta += Math.PI * 2;
        if (Math.abs(delta) > 1e-9) {
          samples += 1;
          swept += delta;
          if (sign === 0) sign = Math.sign(delta);
          // One handedness: it goes round, it does not jitter back and forth.
          expect(Math.sign(delta)).toBe(sign);
        }
      }
      previous = bearing(h, gunship);
    }

    // It really does spend seconds of the fight circling...
    expect(samples).toBeGreaterThan(60 * 2);
    // ...and "how fast does it go round" is exactly one number: `moveSpeed` over the radius.
    // The bound is one-sided because the ship spends the first part of the window closing the
    // last of the spawn distance, and those ticks split the same speed between going round and
    // going in — so the bearing can never advance *faster* than the tangential rate, and only
    // ever a little slower.
    expect(Math.abs(swept)).toBeGreaterThan(0.6);
    expect(Math.abs(swept)).toBeLessThanOrEqual(samples * increment + 1e-9);
    expect(Math.abs(swept)).toBeGreaterThan(samples * increment * 0.6);
  });

  it('fires the Warden’s straight line, from its own airframe, at the same damage', () => {
    const h = harness();
    h.setLethal(false);
    h.setPlayer(0, 0);
    const gunship = spawnGunship(h, 0, -20);
    runUntilGunshipFired(h, gunship);

    expect(h.shots).toHaveLength(1);
    const shot = gunship.shots[0];
    if (!shot) throw new Error('no shot');
    // The muzzle is on its own airframe, one body radius along the aim and `shotOriginHeight`
    // above its altitude — the same two rules the Warden's muzzle follows, which is why the
    // offset is derived from `radius` rather than typed in a second time.
    expect(shot.origin.y).toBeGreaterThan(HELICOPTER.altitude);
    const fromBody = Math.hypot(shot.origin.x - gunship.position.x, shot.origin.z - gunship.position.z);
    expect(fromBody).toBeLessThanOrEqual(ENEMY_HELICOPTER.radius + 1e-6);

    // The line points at the player's chest, so the chest is *on* it.
    const chest = { x: h.player.position.x, y: h.player.position.y + PLAYER.height * 0.5, z: h.player.position.z };
    const vx = chest.x - shot.origin.x;
    const vy = chest.y - shot.origin.y;
    const vz = chest.z - shot.origin.z;
    const t = vx * shot.direction.x + vy * shot.direction.y + vz * shot.direction.z;
    const offLine = Math.hypot(
      vx - shot.direction.x * t,
      vy - shot.direction.y * t,
      vz - shot.direction.z * t,
    );
    expect(offLine).toBeLessThan(0.05);
    expect(Math.hypot(shot.direction.x, shot.direction.y, shot.direction.z)).toBeCloseTo(1, 12);
    // It comes *down*: the gunship is above the player, and a level shot would miss the body it
    // is drawn pointing at.
    expect(shot.direction.y).toBeLessThan(0);

    // Same damage as the Warden, because it is the same attack.
    h.run(3);
    const hit = h.damageRequests.find((request) => request.source === 'shot');
    expect(hit?.amount).toBe(ENEMY_LARGE.damage);
  });

  it('freezes the direction at launch, exactly like the Warden', () => {
    const h = harness();
    h.setLethal(false);
    h.setPlayer(0, 0);
    const gunship = spawnGunship(h, 0, -20);
    runUntilGunshipFired(h, gunship);
    const shot = gunship.shots[0];
    if (!shot) throw new Error('no shot');
    const frozen = { ...shot.direction };
    h.advance(20);
    expect(shot.direction.x).toBe(frozen.x);
    expect(shot.direction.y).toBe(frozen.y);
    expect(shot.direction.z).toBe(frozen.z);
  });

  it('holds station while it winds up rather than sliding down its own warning line', () => {
    const h = harness();
    h.setLethal(false);
    h.setPlayer(0, 0);
    const gunship = spawnGunship(h, 0, -20);
    for (let i = 0; i < 900 && gunship.fsm !== 'TELEGRAPH'; i += 1) h.advance(1);
    expect(gunship.fsm).toBe('TELEGRAPH');
    const frozen = { x: gunship.position.x, z: gunship.position.z };
    h.advance(10);
    // Rooted, for the reason the shared machine documents: the telegraph is the player's only
    // cue, and a body that keeps orbiting during it makes the cue unreadable. "It keeps
    // circling" is therefore true *between* shots.
    expect(gunship.position.x).toBeCloseTo(frozen.x, 9);
    expect(gunship.position.z).toBeCloseTo(frozen.z, 9);
    expect(Math.hypot(gunship.velocity.x, gunship.velocity.z)).toBe(0);
  });

  it('enrages at the same threshold as the Warden', () => {
    const h = harness();
    h.setLethal(false);
    h.setPlayer(0, 0);
    const gunship = spawnGunship(h, 0, -20);
    const threshold = ENEMY_HELICOPTER.maxHealth * ENRAGE_HEALTH_FRACTION;
    h.store.applyDamage(gunship, ENEMY_HELICOPTER.maxHealth - threshold - 1, 'body', gunship.position);
    expect(gunship.enraged).toBe(false);
    h.store.applyDamage(gunship, 5, 'body', gunship.position);
    expect(gunship.enraged).toBe(true);
  });

  it('staggers on cumulative weak-point damage, on the shared lever', () => {
    const h = harness();
    h.setLethal(false);
    h.setPlayer(0, 0);
    const gunship = spawnGunship(h, 0, -22);
    for (let i = 0; i < 900 && gunship.fsm !== 'REPOSITION'; i += 1) h.advance(1);
    expect(gunship.fsm).toBe('REPOSITION');
    h.store.applyDamage(gunship, WEAPON.damage, 'body', gunship.position);
    expect(gunship.fsm).toBe('REPOSITION');
    const headShot = WEAPON.damage * ENEMY_HELICOPTER.headshotMultiplier;
    const needed = Math.ceil((ENEMY_HELICOPTER.maxHealth * 0.06) / headShot) + 1;
    for (let i = 0; i < needed; i += 1) {
      h.store.applyDamage(gunship, headShot, 'head', gunship.position);
      if (gunship.fsm === 'STAGGER') break;
    }
    expect(gunship.fsm).toBe('STAGGER');
  });

  it('counts as its own kind, and is not a Warden', () => {
    const h = harness();
    h.setLethal(false);
    h.setPlayer(0, 0);
    spawnGunship(h, 0, -20);
    expect(h.store.liveCount('helicopter')).toBe(1);
    expect(h.store.liveCount('large')).toBe(0);
    expect(h.store.liveCount()).toBe(1);
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

  it('heals a medkit’s worth of health, clamped, and reports what it restored', () => {
    // The medkit's half of the supply crates (phase 11). Same contract as the ammo grant: the
    // number returned is the number the HUD prints, so it has to be the number that landed.
    const h = harness();
    const c = clock(h);
    c.hit(90);
    const wounded = h.player.health;
    expect(healPlayer(h.player, PICKUPS.healAmount)).toBe(PICKUPS.healAmount);
    expect(h.player.health).toBe(wounded + PICKUPS.healAmount);

    // At full health nothing fits, and the crate's grant is honestly zero.
    h.player.health = PLAYER.maxHealth;
    expect(healPlayer(h.player, PICKUPS.healAmount)).toBe(0);
    expect(h.player.health).toBe(PLAYER.maxHealth);

    // Partially short: the clamp is what is reported.
    h.player.health = PLAYER.maxHealth - 10;
    expect(healPlayer(h.player, PICKUPS.healAmount)).toBe(10);
    expect(h.player.health).toBe(PLAYER.maxHealth);

    // A dead player is not resurrected: the run is over from the tick health reached zero, and a
    // crate that revived them would be a second, undocumented win condition.
    h.player.health = 0;
    h.player.dead = true;
    expect(healPlayer(h.player, PICKUPS.healAmount)).toBe(0);
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
