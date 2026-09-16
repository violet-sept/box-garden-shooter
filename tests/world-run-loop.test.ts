/**
 * The whole game, end to end: the scripted run, spawns, items, and the end of a run.
 *
 * This file did this job for phase 3 against the wave director (`world-wave-loop.test.ts`).
 * The director is now a fixed script, so the assertions are about the *wiring* — which is
 * where every one of these bugs would hide, and which no unit test can reach:
 *
 *   - that the ten-second countdown really is ten seconds of an empty arena, measured on the
 *     simulation clock rather than on the director's own timer;
 *   - that the five drops land 5/5/5/5/10 at 10/20/30/40/50 s with their warnings in front of
 *     them, so the player sees the ring before the body;
 *   - that the Warden's body carries **4800** HP, which is the one place the doubling
 *     requested for it can be observed end to end;
 *   - that a cleared field is what releases it, and that nothing else ever does.
 *
 * Everything here is pure data: no renderer, no DOM, no clock.
 */

import { describe, expect, it } from 'vitest';
import { DIRECTOR, ENEMY_LARGE, ITEMS, PLAYER, SIM } from '#/core/config';
import { EventBus } from '#/core/events';
import type { InputIntent } from '#/core/input';
import type { Vector3 } from '#/core/math/vec3';
import { createWorld, type World } from '#/game/World';
import { totalSmallEnemies } from '#/game/director/deployment';
import { isInViewCone } from '#/game/director/spawnPoints';

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
    toggleView: false,
    lookDeltaX: 0,
    lookDeltaY: 0,
    ...overrides,
  };
}

interface Harness {
  readonly world: World;
  readonly events: EventBus;
  readonly seen: string[];
  /**
   * Every spawn announcement, in order, stamped with the run clock **and the player state
   * it was chosen against**.
   *
   * The player position is captured here rather than read back at assertion time, because
   * the two spawn rules being checked are about the moment of the announcement: a point
   * that was 12 m away when it was chosen is a legal point even if the player has since
   * walked towards it. The old version of this test compared against the player's *current*
   * position and passed only because the player happened not to close the gap.
   */
  readonly pending: {
    archetype: string;
    position: Vector3;
    at: number;
    fromPlayer: Vector3;
    yaw: number;
  }[];
  readonly spawned: { archetype: string; position: Vector3; at: number }[];
  readonly bossSpawns: { enemyId: number; at: number }[];
  /** Where each thrown item actually went off. */
  readonly explosions: { position: Vector3; radius: number; hits: number }[];
}

function makeWorld(seed = 4242): Harness {
  const events = new EventBus();
  const seen: string[] = [];
  const pending: Harness['pending'] = [];
  const spawned: { archetype: string; position: Vector3; at: number }[] = [];
  const bossSpawns: { enemyId: number; at: number }[] = [];
  const explosions: { position: Vector3; radius: number; hits: number }[] = [];
  const world = createWorld({ events, seed });

  for (const name of [
    'assault:started',
    'field:cleared',
    'boss:spawned',
    'boss:died',
    'spawn:pending',
    'enemy:spawned',
    'item:thrown',
    'item:exploded',
    'player:damaged',
    'player:died',
    'enemy:died',
    'run:victory',
    'run:defeat',
  ] as const) {
    events.on(name, () => seen.push(name));
  }

  events.on('spawn:pending', (payload) => {
    pending.push({
      archetype: payload.archetype,
      position: { x: payload.position.x, y: payload.position.y, z: payload.position.z },
      at: world.time,
      fromPlayer: { x: world.player.position.x, y: world.player.position.y, z: world.player.position.z },
      yaw: world.player.yaw,
    });
  });
  events.on('enemy:spawned', (payload) => {
    spawned.push({
      archetype: payload.archetype,
      position: { x: payload.position.x, y: payload.position.y, z: payload.position.z },
      at: world.time,
    });
  });
  events.on('boss:spawned', (payload) => {
    bossSpawns.push({ enemyId: payload.enemyId, at: world.time });
  });
  events.on('item:exploded', (payload) => {
    explosions.push({
      position: { x: payload.position.x, y: payload.position.y, z: payload.position.z },
      radius: payload.radius,
      hits: payload.hits,
    });
  });

  return { world, events, seen, pending, spawned, bossSpawns, explosions };
}

/** Runs `steps` ticks, letting the caller vary the intent per tick. */
function step(world: World, steps: number, input: (index: number) => InputIntent): void {
  for (let i = 0; i < steps; i += 1) world.tick(DT, input(i));
}

/** Runs `seconds` of simulation with one intent. */
function run(world: World, seconds: number, input: InputIntent): void {
  step(world, Math.round(seconds * SIM.tickHz), () => input);
}

/**
 * Runs `seconds` with the player's health topped up every tick.
 *
 * The scene tests that put thirty Stalkers on the field and then leave them there are
 * about the *spawn schedule*, and an unarmed player standing in a swarm dies in about
 * twenty seconds — which stops the schedule rather than exercising it. Topping the health
 * up before each tick keeps the run alive without touching what is being measured.
 */
function runUnkillable(world: World, seconds: number, input: InputIntent = intent()): void {
  const steps = Math.round(seconds * SIM.tickHz);
  for (let i = 0; i < steps; i += 1) {
    world.player.health = PLAYER.maxHealth;
    world.tick(DT, input);
  }
}

/** `step`, with the same health top-up. */
function stepUnkillable(world: World, steps: number, input: (index: number) => InputIntent): void {
  for (let i = 0; i < steps; i += 1) {
    world.player.health = PLAYER.maxHealth;
    world.tick(DT, input(i));
  }
}

/** Removes every live combatant, leaving the practice dummies. */
function despawnCombatants(world: World): void {
  // Snapshot then despawn: `despawn` swaps the last entry into the freed slot, so a
  // forward loop over the live array skips the entry it just moved.
  for (const enemy of [...world.enemies.targets]) {
    if (enemy.kind !== 'dummy') world.enemies.despawn(enemy);
  }
}

/** How many practice dummies the level placed. They are never recycled. */
function dummyCount(world: World): number {
  return world.enemies.targets.filter((enemy) => enemy.kind === 'dummy').length;
}

/** Every live combatant of a kind. */
function live(world: World, kind: 'small' | 'large') {
  return world.enemies.targets.filter((enemy) => enemy.alive && enemy.kind === kind);
}

/** Plays until the director reaches `phase`, clearing the field each tick. */
function playTo(world: World, phase: string, limitSeconds = 200): void {
  const steps = Math.round(limitSeconds * SIM.tickHz);
  for (let i = 0; i < steps; i += 1) {
    world.tick(DT, intent());
    if (world.director.status.phase === phase) return;
    // The Warden is only removed once the director has *seen* it: a body that appeared at
    // the end of this tick cannot have been shot during it (the release queue runs after
    // the shot), so `BOSS_INCOMING` has to be allowed to become `BOSS_ACTIVE` first.
    // Everything dies through the damage pipeline rather than through `despawn`, so the
    // death events (`enemy:died` → `boss:died`) are the real ones.
    const seenBoss = world.director.status.phase === 'BOSS_ACTIVE';
    for (const enemy of [...world.enemies.targets]) {
      if (enemy.kind === 'dummy') continue;
      if (enemy.kind === 'large' && !seenBoss) continue;
      world.enemies.applyDamage(enemy, 1e6, 'body', enemy.position);
    }
  }
  throw new Error(`the phase never became ${phase}; stuck in ${world.director.status.phase}`);
}

describe('the scripted run is wired end to end', () => {
  it('starts empty, holds the arena empty for ten seconds, then drops the first five', () => {
    const harness = makeWorld();
    const { world } = harness;
    // Nothing but practice dummies before a single tick has run.
    expect(world.enemies.liveCount()).toBe(0);
    expect(world.director.status.phase).toBe('OPENING');

    // The countdown is real time on the simulation clock, and nothing at all happens in it.
    run(world, DIRECTOR.openingCountdown - 0.5, intent());
    expect(world.enemies.liveCount()).toBe(0);
    expect(harness.pending).toHaveLength(0);
    expect(harness.spawned).toHaveLength(0);
    expect(world.director.status.timer).toBeGreaterThan(0);
    // The run's own opening beat has been announced, which is what puts the countdown on
    // screen in the first place.
    expect(harness.seen).toContain('assault:started');

    run(world, 0.7, intent());
    expect(world.director.status.phase).toBe('DEPLOYING');
    // Five orders, issued on the tick the countdown reached zero, and five ground rings.
    expect(harness.pending.filter((entry) => entry.archetype === 'small')).toHaveLength(5);
    expect(world.enemies.liveCount('small')).toBe(0);

    // Bodies appear once their warning has elapsed — that gap is the whole point of it.
    run(world, DIRECTOR.spawnWarningDuration + 0.1, intent());
    expect(world.enemies.liveCount('small')).toBe(5);
    expect(harness.seen).toContain('enemy:spawned');
  });

  it('releases thirty small enemies in five drops of 5/5/5/5/10, ten seconds apart', () => {
    const harness = makeWorld();
    const { world } = harness;
    // Sixty-two seconds covers the whole script (the last drop lands at 50 + its warning).
    // Nothing dies in it, so the swarm has to be survivable for the schedule to be read.
    runUnkillable(world, 62);

    const bodies = harness.spawned.filter((entry) => entry.archetype === 'small');
    expect(bodies).toHaveLength(30);
    expect(totalSmallEnemies()).toBe(30);
    expect(world.director.status.plannedSmall).toBe(30);
    expect(world.director.status.remaining).toBe(0);

    // Group the arrivals by the tick they landed on: the drops must keep their shapes.
    const drops: number[] = [];
    for (const body of bodies) {
      if (drops.length === 0 || body.at - (drops[drops.length - 1] ?? 0) > 0.5) drops.push(body.at);
    }
    expect(drops).toHaveLength(5);
    const sizes = drops.map(
      (at, index) => bodies.filter((body) => body.at >= at - 0.01 && body.at < (drops[index + 1] ?? Infinity)).length,
    );
    expect(sizes).toEqual([5, 5, 5, 5, 10]);
    // The brief's cadence: ten seconds from the start of the run, then every ten seconds.
    drops.forEach((at, index) => {
      expect(at).toBeCloseTo(DIRECTOR.openingCountdown + DIRECTOR.batchInterval * index + DIRECTOR.spawnWarningDuration, 1);
    });

    // And with the field still full there is no Warden and no results screen.
    expect(harness.bossSpawns).toHaveLength(0);
    expect(world.director.status.phase).toBe('CLEARING');
    expect(world.enemies.liveCount('small')).toBe(30);
  });

  it('announces every spawn before the body exists, and only then', () => {
    const harness = makeWorld();
    const { world } = harness;
    run(world, DIRECTOR.openingCountdown + 4, intent());

    expect(harness.pending.length).toBeGreaterThan(0);
    // Every body is announced first, in the same order. An unannounced spawn is exactly
    // the "it appeared in my face" bug the filter exists to prevent.
    expect(harness.spawned.length).toBeGreaterThan(0);
    expect(harness.spawned.length).toBeLessThanOrEqual(harness.pending.length);
    for (let i = 0; i < harness.spawned.length; i += 1) {
      expect(harness.spawned[i]?.archetype).toBe(harness.pending[i]?.archetype);
      expect(harness.spawned[i]?.position.x).toBeCloseTo(harness.pending[i]?.position.x ?? NaN, 6);
      expect(harness.spawned[i]?.position.z).toBeCloseTo(harness.pending[i]?.position.z ?? NaN, 6);
      // The body lands *after* the announcement, by the configured warning.
      expect((harness.spawned[i]?.at ?? 0) - (harness.pending[i]?.at ?? 0)).toBeGreaterThanOrEqual(
        DIRECTOR.spawnWarningDuration - DT * 2,
      );
    }
    // Any announcement without a body yet must be one whose warning is still running,
    // and there are only ever a handful of those — an announcement with no body and no
    // warning left would be a promise the arena did not keep.
    expect(harness.pending.length - harness.spawned.length).toBeLessThanOrEqual(world.director.status.inFlightSmall);
  });

  it('never spawns an enemy in the player’s face, in view, or outside the arena', () => {
    const harness = makeWorld();
    const { world } = harness;
    // A long run with the player moving and looking around, so the filter is exercised
    // from more than one position and facing — and kept alive, or the swarm would end the
    // run before the later drops were even scheduled.
    stepUnkillable(world, Math.round(55 * SIM.tickHz), (i) =>
      intent({ move: { forward: i % 200 < 100 ? 1 : -1, right: i % 140 < 70 ? 1 : -1 }, lookDeltaX: 2 }),
    );

    expect(harness.pending.length).toBeGreaterThan(5);
    for (const entry of harness.pending) {
      const player = entry.fromPlayer;
      const distance = Math.hypot(entry.position.x - player.x, entry.position.z - player.z);
      // The one rule with no exception: never inside the arena's fence.
      expect(Math.abs(entry.position.x)).toBeLessThanOrEqual(SIM.arenaHalfSize);
      expect(Math.abs(entry.position.z)).toBeLessThanOrEqual(SIM.arenaHalfSize);
      // And never closer than the configured minimum, measured against the player's
      // position *at the moment the point was chosen* — which is the one the player saw
      // when the ring appeared.
      expect(distance).toBeGreaterThanOrEqual(DIRECTOR.minSpawnDistanceFromPlayer - 1e-6);
      // Same for the keep-out cone: it is a rule about the facing the choice was made
      // against, not about wherever the player happens to be looking later.
      expect(isInViewCone(entry.position, player, entry.yaw, DIRECTOR.spawnViewConeHalfAngleDeg)).toBe(false);
    }
  });

  it('releases the Warden once the field is clear, and reaches victory when it dies', () => {
    const harness = makeWorld();
    const { world } = harness;
    playTo(world, 'BOSS_INCOMING');
    expect(harness.seen).toContain('field:cleared');
    // The order is announced on the tick the director decides, and the body appears
    // once its warning has elapsed — that gap is the whole point of the warning, so the
    // event deliberately waits for the body to exist before publishing an id.
    expect(harness.pending.some((entry) => entry.archetype === 'large')).toBe(true);
    expect(harness.bossSpawns).toHaveLength(0);
    expect(world.enemies.liveCount('large')).toBe(0);

    playTo(world, 'BOSS_ACTIVE');
    expect(harness.bossSpawns).toHaveLength(1);
    expect(world.enemies.liveCount('large')).toBe(1);
    const bossId = harness.bossSpawns[0]?.enemyId ?? -1;
    expect(bossId).toBeGreaterThan(0);
    const boss = world.enemies.byId(bossId);
    expect(boss?.kind).toBe('large');
    // The one place the doubling is observable end to end: the body that actually walks
    // onto the field carries twice the 2400 it used to.
    expect(ENEMY_LARGE.maxHealth).toBe(4800);
    expect(boss?.stats.maxHealth).toBe(4800);
    expect(boss?.health).toBe(4800);
    // Only one, ever.
    expect(live(world, 'large')).toHaveLength(1);

    playTo(world, 'VICTORY');
    expect(harness.seen).toContain('boss:died');
    expect(world.director.status.outcome).toBe('victory');
    expect(harness.bossSpawns).toHaveLength(1);
  });

  it('never releases the Warden while a single Stalker is alive', () => {
    const harness = makeWorld();
    const { world } = harness;
    // Ninety seconds with the whole script on the field and the player kept alive: the boss
    // gate is "the field is clear", and this is the negative of it.
    runUnkillable(world, 90);
    expect(world.enemies.liveCount('small')).toBe(30);
    expect(harness.bossSpawns).toHaveLength(0);
    expect(harness.seen).not.toContain('field:cleared');
    expect(harness.seen).not.toContain('boss:spawned');
    expect(world.director.status.phase).toBe('CLEARING');
    expect(world.director.status.outcome).toBe('running');

    // Kill all but one, and it still waits.
    const survivors = live(world, 'small');
    for (const enemy of survivors.slice(1)) world.enemies.despawn(enemy);
    world.tick(DT, intent());
    runUnkillable(world, 20);
    expect(harness.bossSpawns).toHaveLength(0);
  });

  it('never puts more small enemies on the field than the script contains', () => {
    const harness = makeWorld();
    const { world } = harness;
    let peak = 0;
    stepUnkillable(world, Math.round(80 * SIM.tickHz), () => {
      peak = Math.max(peak, world.enemies.liveCount('small'));
      return intent();
    });
    // Nothing dies in this run, so this is the script's whole total — which is the bound
    // that replaced the phase-3 concurrency cap (14 would have clipped the third drop).
    expect(peak).toBe(30);
    expect(peak).toBe(totalSmallEnemies());
    expect(world.director.status.inFlightSmall).toBe(0);
  });

  it('recycles every corpse the tick it dies, whoever killed it', () => {
    const harness = makeWorld();
    const { world } = harness;
    run(world, DIRECTOR.openingCountdown + 6, intent());
    const bodies = world.enemies.targets.length;

    for (const enemy of [...world.enemies.targets]) {
      if (enemy.kind === 'dummy') continue;
      world.enemies.applyDamage(enemy, 1e6, 'body', enemy.position);
    }
    // Cleanup runs inside the tick, so one tick is enough for every body to be gone.
    world.tick(DT, intent());
    expect(world.enemies.liveCount()).toBe(0);
    expect(world.enemies.targets.every((enemy) => enemy.alive)).toBe(true);
    expect(world.enemies.targets.length).toBe(dummyCount(world));
    // The store lost the bodies rather than accumulating them.
    expect(world.enemies.targets.length).toBeLessThanOrEqual(bodies);
  });

  it('never lets the entry list grow across a long run, resets or not', () => {
    const harness = makeWorld();
    const { world } = harness;
    const ceiling = dummyCount(world) + totalSmallEnemies() + 1;
    stepUnkillable(world, Math.round(90 * SIM.tickHz), (i) => {
      // Churn: kill half of everything every couple of seconds, so bodies come and go.
      if (i % 120 === 0) {
        for (const enemy of [...world.enemies.targets].slice(0, 2)) {
          if (enemy.kind !== 'dummy') world.enemies.despawn(enemy);
        }
      }
      expect(world.enemies.targets.length).toBeLessThanOrEqual(ceiling);
      return intent();
    });
    expect(Number.isFinite(world.time)).toBe(true);
  });

  it('never produces NaN anywhere in the world over a long run', () => {
    const harness = makeWorld();
    const { world } = harness;
    stepUnkillable(world, Math.round(60 * SIM.tickHz), (i) =>
      intent({ move: { forward: 1, right: i % 90 < 45 ? 1 : -1 }, sprint: true, lookDeltaX: 17, lookDeltaY: 3 }),
    );
    for (const enemy of world.enemies.targets) {
      for (const value of [
        enemy.position.x,
        enemy.position.y,
        enemy.position.z,
        enemy.velocity.x,
        enemy.velocity.y,
        enemy.velocity.z,
        enemy.stateTime,
      ]) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
    for (const slot of world.items.throwables) {
      expect(Number.isFinite(slot.position.x)).toBe(true);
      expect(Number.isFinite(slot.position.y)).toBe(true);
    }
    expect(Number.isFinite(world.player.health)).toBe(true);
    expect(Number.isFinite(world.time)).toBe(true);
  });
});

describe('the item loop is wired end to end', () => {
  it('spends a charge on E, and the item really leaves the hand', () => {
    const harness = makeWorld();
    const { world } = harness;
    const before = world.charges;
    expect(before).toBeGreaterThan(0);

    world.tick(DT, intent({ throwItem: true }));

    expect(world.charges).toBe(before - 1);
    expect(world.items.activeCount()).toBe(1);
    expect(harness.seen).toContain('item:thrown');
    expect(world.stats.itemsThrown).toBe(1);
  });

  it('does not spend a charge when the cooldown refuses the throw', () => {
    const harness = makeWorld();
    const { world } = harness;
    world.tick(DT, intent({ throwItem: true }));
    const after = world.charges;
    // Inside the cooldown: the intent is consumed, but nothing leaves the hand and no
    // charge is lost. A throw that silently eats a charge is worse than one that fails.
    world.tick(DT, intent({ throwItem: true }));
    expect(world.charges).toBe(after);
    expect(world.items.activeCount()).toBe(1);
  });

  it('refuses to throw with no charges, and does not go negative', () => {
    const harness = makeWorld();
    const { world } = harness;
    world.charges = 0;
    run(world, 0.5, intent({ throwItem: true }));
    expect(world.charges).toBe(0);
    expect(world.items.activeCount()).toBe(0);
    expect(world.stats.itemsThrown).toBe(0);
  });

  it('detonates on the fuse and damages the enemies inside the blast', () => {
    const harness = makeWorld();
    const { world } = harness;
    world.player.health = 100_000;
    world.player.yaw = 0;
    world.player.pitch = 0;

    // Two throws from the same facing. The first measures where a grenade actually
    // lands — placing the group on a *predicted* point would test the prediction
    // rather than the blast — and the second is the one the enemies are standing under.
    expect(world.throwOnce()).toBe(true);
    run(world, ITEMS.fuse + 0.3, intent());
    const measured = harness.explosions.at(-1);
    expect(measured).toBeDefined();
    if (!measured) return;
    const impact = measured.position;

    run(world, ITEMS.throwCooldown, intent());
    expect(world.throwOnce()).toBe(true);
    // Bring the fuse to the brink, then put the group under it. The small enemy's FSM
    // charges at 9 m/s, so an enemy placed at the start of the flight would have run
    // into the player's lap long before the grenade landed.
    run(world, ITEMS.fuse - 0.05, intent());

    const victims = [
      world.enemies.spawn('small', { x: impact.x, y: 0, z: impact.z }, { state: 'IDLE' }),
      world.enemies.spawn('small', { x: impact.x + 1.5, y: 0, z: impact.z }, { state: 'IDLE' }),
      world.enemies.spawn('small', { x: impact.x - 1.5, y: 0, z: impact.z + 1 }, { state: 'IDLE' }),
    ];
    // Well outside the radius: the far wall of the arena.
    const bystander = world.enemies.spawn(
      'large',
      { x: impact.x, y: 0, z: -SIM.arenaHalfSize + 2 },
      { state: 'IDLE' },
    );
    expect(Math.hypot(bystander.position.x - impact.x, bystander.position.z - impact.z)).toBeGreaterThan(
      ITEMS.blastRadius * 2,
    );

    run(world, 0.2, intent());

    expect(harness.explosions.length).toBe(2);
    expect(harness.seen).toContain('item:exploded');
    expect(world.items.activeCount()).toBe(0);
    expect(world.stats.blastHits).toBeGreaterThan(0);
    expect(victims.some((enemy) => enemy.totalDamageTaken > 0)).toBe(true);
    expect(bystander.totalDamageTaken).toBe(0);
  });

  it('clears its items and its charges on reset', () => {
    const harness = makeWorld();
    const { world } = harness;
    run(world, DIRECTOR.openingCountdown + 2, intent());
    world.throwOnce();
    expect(world.items.activeCount()).toBe(1);
    world.charges = 1;

    world.reset();
    expect(world.items.activeCount()).toBe(0);
    expect(world.charges).toBe(ITEMS.startingCharges);
    expect(world.stats.itemsThrown).toBe(0);
    expect(world.stats.blastHits).toBe(0);
  });

  it('tops the belt up once, when the field is cleared', () => {
    const harness = makeWorld();
    const { world } = harness;
    world.charges = 0;
    playTo(world, 'BOSS_INCOMING');
    // The run's one beat: the script pays exactly `ITEMS.chargesPerClear`, and the field
    // being cleared is the only thing that pays it.
    expect(harness.seen).toContain('field:cleared');
    expect(world.charges).toBe(ITEMS.chargesPerClear);
    for (let i = 0; i < 60 * 20; i += 1) world.tick(DT, intent());
    expect(world.charges).toBe(ITEMS.chargesPerClear);
  });
});

describe('the run ends and can be restarted', () => {
  it('reaches DEFEAT when the player dies, and stops spawning', () => {
    const harness = makeWorld();
    const { world } = harness;
    run(world, DIRECTOR.openingCountdown + 3, intent());
    expect(world.enemies.liveCount('small')).toBeGreaterThan(0);

    // Kill the player the way the game does: through the damage pipeline, not by
    // setting the flag, so the i-frames and the death path are the real ones.
    world.player.health = 1;
    run(world, 20, intent());

    expect(world.player.dead).toBe(true);
    expect(harness.seen).toContain('player:died');
    expect(world.director.status.outcome).toBe('defeat');
    expect(harness.seen).toContain('run:defeat');

    // And nothing new arrives afterwards, even with the field cleared.
    const announced = harness.pending.length;
    for (let i = 0; i < 60 * 30; i += 1) {
      world.tick(DT, intent());
      despawnCombatants(world);
    }
    expect(harness.pending.length).toBe(announced);
    expect(harness.seen.filter((name) => name === 'run:defeat')).toHaveLength(1);
  });

  it('reaches VICTORY when the Warden dies, and only once', () => {
    const harness = makeWorld(7);
    const { world } = harness;
    playTo(world, 'VICTORY', 400);
    expect(world.director.status.outcome).toBe('victory');
    expect(harness.seen).toContain('run:victory');
    expect(harness.seen.filter((name) => name === 'run:victory')).toHaveLength(1);
    expect(harness.bossSpawns).toHaveLength(1);

    // No further arrivals after the win.
    const announced = harness.pending.length;
    for (let i = 0; i < 60 * 10; i += 1) world.tick(DT, intent());
    expect(harness.pending.length).toBe(announced);
  });

  it('comes back to a clean opening after a reset', () => {
    const harness = makeWorld();
    const { world } = harness;
    run(world, DIRECTOR.openingCountdown + 6, intent());
    run(world, 20, intent({ throwItem: true }));
    despawnCombatants(world);

    world.reset();

    expect(world.director.status.phase).toBe('OPENING');
    expect(world.director.status.batch).toBe(1);
    expect(world.director.status.outcome).toBe('running');
    expect(world.enemies.liveCount()).toBe(0);
    expect(world.enemies.targets.length).toBe(dummyCount(world));
    expect(world.player.health).toBe(PLAYER.maxHealth);
    expect(world.player.dead).toBe(false);
    expect(world.charges).toBe(ITEMS.startingCharges);
    expect(world.items.activeCount()).toBe(0);
    expect(world.time).toBe(0);
    expect(world.stats.ticks).toBe(0);
    expect(world.stats.targetsKilled).toBe(0);
    expect(world.stats.enemyHitsLanded).toBe(0);
    expect(world.stats.playerDamageTaken).toBe(0);
    expect(world.enemies.damagedCount()).toBe(0);
    expect(world.director.status.timer).toBeCloseTo(DIRECTOR.openingCountdown, 6);

    // And the second run really starts again rather than staying silent: the countdown
    // first, then a fresh batch.
    expect(world.enemies.liveCount('small')).toBe(0);
    run(world, DIRECTOR.openingCountdown + DIRECTOR.spawnWarningDuration + 0.2, intent());
    expect(world.director.status.phase).toBe('DEPLOYING');
    expect(world.enemies.liveCount('small')).toBe(5);
  });

  it('gives the same run from the same seed, script and spawn points alike', () => {
    const a = makeWorld(1234);
    const b = makeWorld(1234);
    for (let i = 0; i < Math.round(45 * SIM.tickHz); i += 1) {
      a.world.tick(DT, intent());
      b.world.tick(DT, intent());
    }
    expect(b.pending.length).toBe(a.pending.length);
    expect(b.pending.map((entry) => entry.position)).toEqual(a.pending.map((entry) => entry.position));
    expect(b.world.director.status.phase).toBe(a.world.director.status.phase);
    expect(b.world.enemies.liveCount('small')).toBe(a.world.enemies.liveCount('small'));
  });

  it('gives a different run from a different seed', () => {
    // The schedule is now identical for every run, so the *only* thing a seed still buys
    // is where the bodies appear — which is precisely what this pins.
    const a = makeWorld(1);
    const b = makeWorld(2);
    for (let i = 0; i < Math.round(45 * SIM.tickHz); i += 1) {
      a.world.tick(DT, intent());
      b.world.tick(DT, intent());
    }
    expect(a.pending.length).toBeGreaterThan(0);
    expect(b.pending.map((entry) => entry.position)).not.toEqual(a.pending.map((entry) => entry.position));
  });
});

describe('the director does not share the shooting random stream', () => {
  it('keeps every spawn point identical no matter how many shots were fired', () => {
    // The trap this pins (hard rule 7): `World`'s `rng` is consumed twice per bullet for
    // spread, so a director sharing that stream would make every spawn point depend on how
    // trigger-happy the player was, and "same seed, same sequence" would be false in the
    // only way that matters.
    //
    // The firing player aims into the sky, so the trigger consumes the combat stream
    // without changing anything else about the world: any difference in the announced
    // points could then only have come from a shared stream.
    const quiet = makeWorld(99);
    const noisy = makeWorld(99);
    const ticks = Math.round((DIRECTOR.openingCountdown + 3.5) * SIM.tickHz);

    for (let i = 0; i < ticks; i += 1) {
      noisy.world.player.pitch = 1.3;
      quiet.world.tick(DT, intent());
      noisy.world.tick(DT, intent({ fire: true }));
    }

    // The trigger really did fire, or this proves nothing.
    expect(noisy.world.stats.shotsFired).toBeGreaterThan(10);
    expect(quiet.world.stats.shotsFired).toBe(0);
    expect(quiet.pending.length).toBeGreaterThan(2);
    expect(noisy.pending.length).toBe(quiet.pending.length);
    expect(noisy.pending.map((entry) => entry.position)).toEqual(quiet.pending.map((entry) => entry.position));
  });

  it('keeps two silent runs identical, as the control', () => {
    const a = makeWorld(99);
    const b = makeWorld(99);
    for (let i = 0; i < Math.round(20 * SIM.tickHz); i += 1) {
      a.world.tick(DT, intent());
      b.world.tick(DT, intent());
    }
    expect(a.pending.length).toBeGreaterThan(0);
    expect(a.pending.map((entry) => entry.position)).toEqual(b.pending.map((entry) => entry.position));
  });
});
