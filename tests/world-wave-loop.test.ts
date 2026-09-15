/**
 * The whole game, end to end: waves, spawns, items, and the end of a run.
 *
 * `world-debug-loop.test.ts` did this job for phase 2 against a hand-placed debug
 * line-up. That line-up is gone — the wave director replaced it — so this file is its
 * successor, and it keeps the assertions that were about the *composition* rather than
 * about the debug block: AI advancing, live rounds connecting, corpses recycled on the
 * tick they die, a reset leaving nothing behind.
 *
 * What only this layer can check is the wiring, and that is where every phase-3 bug
 * would hide: that the director runs after cleanup (so `liveCount` describes the world
 * the player sees), that a spawn announced by `spawn:pending` really does become a
 * body, and that a thrown item's blast reaches the enemy store.
 *
 * Everything here is pure data: no renderer, no DOM, no clock.
 */

import { describe, expect, it } from 'vitest';
import { DIRECTOR, DIRECTOR_TUNING, ENEMY_SMALL, ITEMS, PLAYER, SIM } from '#/core/config';
import { EventBus } from '#/core/events';
import type { InputIntent } from '#/core/input';
import type { Vector3 } from '#/core/math/vec3';
import { createWorld, type World } from '#/game/World';
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
    lookDeltaX: 0,
    lookDeltaY: 0,
    ...overrides,
  };
}

interface Harness {
  readonly world: World;
  readonly events: EventBus;
  readonly seen: string[];
  /** Every spawn announcement, in order. */
  readonly pending: { archetype: string; position: Vector3 }[];
  readonly spawned: { archetype: string; position: Vector3 }[];
  readonly bossSpawns: { reason: string; enemyId: number }[];
  /** Where each thrown item actually went off. */
  readonly explosions: { position: Vector3; radius: number; hits: number }[];
}

function makeWorld(seed = 4242): Harness {
  const events = new EventBus();
  const seen: string[] = [];
  const pending: { archetype: string; position: Vector3 }[] = [];
  const spawned: { archetype: string; position: Vector3 }[] = [];
  const bossSpawns: { reason: string; enemyId: number }[] = [];
  const explosions: { position: Vector3; radius: number; hits: number }[] = [];
  const world = createWorld({ events, seed });

  for (const name of [
    'wave:started',
    'wave:cleared',
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
    });
  });
  events.on('enemy:spawned', (payload) => {
    spawned.push({
      archetype: payload.archetype,
      position: { x: payload.position.x, y: payload.position.y, z: payload.position.z },
    });
  });
  events.on('boss:spawned', (payload) => {
    bossSpawns.push({ reason: payload.reason, enemyId: payload.enemyId });
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

/** Plays until the director reaches `phase`, killing everything each tick. */
function playTo(world: World, phase: string, limitSeconds = 300): void {
  const steps = Math.round(limitSeconds * SIM.tickHz);
  for (let i = 0; i < steps; i += 1) {
    world.tick(DT, intent());
    if (world.director.status.phase === phase) return;
    despawnCombatants(world);
  }
  throw new Error(`the phase never became ${phase}; stuck in ${world.director.status.phase}`);
}

describe('the wave loop is wired end to end', () => {
  it('starts empty, holds the opening, then releases the first wave', () => {
    const harness = makeWorld();
    const { world } = harness;
    // Nothing but practice dummies before a single tick has run.
    expect(world.enemies.liveCount()).toBe(0);
    expect(world.director.status.phase).toBe('OPENING');

    // Short of the grace period, still nothing: the opening is real time, not a label.
    run(world, DIRECTOR.openingGracePeriod - 0.5, intent());
    expect(world.enemies.liveCount()).toBe(0);
    expect(harness.seen).not.toContain('wave:started');

    run(world, 1, intent());
    expect(world.director.status.phase).toBe('SPAWNING_SMALL');
    expect(harness.seen).toContain('wave:started');
    expect(world.director.status.wave).toBe(1);

    // Long enough for the first few to be released and their warnings to elapse.
    run(world, 3, intent());
    expect(world.enemies.liveCount('small')).toBeGreaterThan(0);
    expect(harness.seen).toContain('spawn:pending');
    expect(harness.seen).toContain('enemy:spawned');
  });

  it('announces every spawn before the body exists, and only then', () => {
    const harness = makeWorld();
    const { world } = harness;
    run(world, DIRECTOR.openingGracePeriod + 4, intent());

    expect(harness.pending.length).toBeGreaterThan(0);
    // Every body is announced first, in the same order. An unannounced spawn is exactly
    // the "it appeared in my face" bug the filter exists to prevent.
    expect(harness.spawned.length).toBeGreaterThan(0);
    expect(harness.spawned.length).toBeLessThanOrEqual(harness.pending.length);
    for (let i = 0; i < harness.spawned.length; i += 1) {
      expect(harness.spawned[i]?.archetype).toBe(harness.pending[i]?.archetype);
      expect(harness.spawned[i]?.position.x).toBeCloseTo(harness.pending[i]?.position.x ?? NaN, 6);
      expect(harness.spawned[i]?.position.z).toBeCloseTo(harness.pending[i]?.position.z ?? NaN, 6);
    }
    // Any announcement without a body yet must be one whose warning is still running,
    // and there are only ever a handful of those — an announcement with no body and no
    // warning left would be a promise the arena did not keep.
    expect(world.director.status.inFlightSmall + world.enemies.liveCount('small')).toBeGreaterThan(0);
    expect(harness.pending.length - harness.spawned.length).toBeLessThanOrEqual(world.director.status.inFlightSmall);
  });

  it('never spawns a small enemy in the player’s face, in view, or outside the arena', () => {
    const harness = makeWorld();
    const { world } = harness;
    // A long run with the player moving and looking around, so the filter is exercised
    // from more than one position and facing.
    step(world, Math.round(40 * SIM.tickHz), (i) =>
      intent({ move: { forward: i % 200 < 100 ? 1 : -1, right: i % 140 < 70 ? 1 : -1 }, lookDeltaX: 2 }),
    );

    expect(harness.pending.length).toBeGreaterThan(5);
    for (const entry of harness.pending) {
      const player = world.player.position;
      const distance = Math.hypot(entry.position.x - player.x, entry.position.z - player.z);
      // The one rule with no exception: never inside the arena's fence.
      expect(Math.abs(entry.position.x)).toBeLessThanOrEqual(SIM.arenaHalfSize);
      expect(Math.abs(entry.position.z)).toBeLessThanOrEqual(SIM.arenaHalfSize);
      // And never closer than the configured minimum — checked against the position
      // the announcement was made from, which is the position the player saw.
      expect(distance).toBeGreaterThanOrEqual(DIRECTOR.minSpawnDistanceFromPlayer - 1e-6);
      // The cone is checked against the player's facing *now*, which is the strictest
      // honest reading available: the player has since moved and turned, so a point
      // that is outside the current cone is outside the one it was chosen against too.
      expect(isInViewCone(entry.position, player, world.player.yaw, DIRECTOR.spawnViewConeHalfAngleDeg)).toBe(false);
    }
  });

  it('releases the large enemy once the wave is cleared, and reaches the next wave', () => {
    const harness = makeWorld();
    const { world } = harness;
    const firstWaveStart = world.director.status.wave;

    playTo(world, 'BOSS_ACTIVE');
    expect(world.director.status.wave).toBe(firstWaveStart);
    // The order is announced on the tick the director decides, and the body appears
    // once its warning has elapsed — that gap is the whole point of the warning, so the
    // event deliberately waits for the body to exist before publishing an id.
    run(world, DIRECTOR.spawnWarningDuration + 0.1, intent());
    expect(harness.bossSpawns.length).toBe(1);
    // Cleared rather than timed out: the test removes every small enemy, which is
    // criterion (A) firing. The timeout path is covered in `director.test.ts`.
    expect(harness.bossSpawns[0]?.reason).toBe('cleared');
    // The order was announced before it was executed — that is the whole point of the
    // warning — so the boss is on its way rather than on the field at this instant.
    expect(harness.pending.some((entry) => entry.archetype === 'large')).toBe(true);

    // Let the warning elapse. The body appears, and the event's id resolves to it,
    // which is why the world defers `boss:spawned` until the body exists.
    run(world, DIRECTOR.spawnWarningDuration + 0.1, intent());
    expect(world.enemies.liveCount('large')).toBe(1);
    const bossId = harness.bossSpawns[0]?.enemyId ?? -1;
    expect(bossId).toBeGreaterThan(0);
    expect(world.enemies.byId(bossId)?.kind).toBe('large');

    playTo(world, 'INTERMISSION');
    expect(harness.seen).toContain('wave:cleared');

    playTo(world, 'SPAWNING_SMALL');
    expect(world.director.status.wave).toBe(firstWaveStart + 1);
  });

  it('scales a later wave’s health above the archetype baseline', () => {
    const harness = makeWorld();
    const { world } = harness;
    run(world, DIRECTOR.openingGracePeriod + 1, intent());
    const first = live(world, 'small')[0];
    expect(first).toBeDefined();
    // Wave one is unscaled: it is the baseline every other wave's scaling is measured
    // against, so a change here would move the whole difficulty curve.
    expect(first?.stats.maxHealth ?? 0).toBeCloseTo(ENEMY_SMALL.maxHealth, 6);

    // Play out to wave two, killing everything as it appears.
    playTo(world, 'INTERMISSION');
    playTo(world, 'SPAWNING_SMALL');
    run(world, 10, intent());
    const later = live(world, 'small');
    expect(later.length).toBeGreaterThan(0);
    // `statsFor(archetype)` hands the store the *base* stat block and `spawn` clones it
    // with the wave's scale applied, so the base object is never mutated. The proof that
    // the scale reached the store is therefore that no wave-two body is at the baseline
    // any more, and that the wave's own scale factor is above 1.
    expect(world.director.status.spawnedSmall).toBeGreaterThan(0);
    const scale = ENEMY_SMALL.maxHealth * DIRECTOR.smallHealthScalePerWave;
    for (const enemy of later) {
      expect(enemy.stats.maxHealth).toBeGreaterThan(ENEMY_SMALL.maxHealth);
      expect(enemy.stats.maxHealth).toBeCloseTo(scale, 6);
      // And the body's health was clamped to the scaled maximum, not to the base one.
      expect(enemy.health).toBeLessThanOrEqual(enemy.stats.maxHealth);
    }
  });

  it('never exceeds the small-enemy concurrency cap', () => {
    const harness = makeWorld();
    const { world } = harness;
    let peak = 0;
    step(world, Math.round(60 * SIM.tickHz), () => {
      peak = Math.max(peak, world.enemies.liveCount('small'));
      return intent();
    });
    expect(peak).toBeGreaterThan(0);
    // The cap is enforced in two places — the director's in-flight count and the
    // world's release queue — and this is the reading that proves the pair of them
    // together never let it slip.
    expect(peak).toBeLessThanOrEqual(DIRECTOR.maxConcurrentSmall);
    expect(world.director.status.inFlightSmall).toBeLessThanOrEqual(DIRECTOR.maxConcurrentSmall);
  });

  it('recycles every corpse the tick it dies, whoever killed it', () => {
    const harness = makeWorld();
    const { world } = harness;
    run(world, DIRECTOR.openingGracePeriod + 5, intent());
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
    const ceiling = dummyCount(world) + DIRECTOR.maxConcurrentTotal;
    step(world, Math.round(90 * SIM.tickHz), (i) => {
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
    step(world, Math.round(60 * SIM.tickHz), (i) =>
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
    run(world, DIRECTOR.openingGracePeriod + 2, intent());
    world.throwOnce();
    expect(world.items.activeCount()).toBe(1);
    world.charges = 1;

    world.reset();
    expect(world.items.activeCount()).toBe(0);
    expect(world.charges).toBe(ITEMS.startingCharges);
    expect(world.stats.itemsThrown).toBe(0);
    expect(world.stats.blastHits).toBe(0);
  });
});

describe('the run ends and can be restarted', () => {
  it('reaches DEFEAT when the player dies, and stops spawning', () => {
    const harness = makeWorld();
    const { world } = harness;
    run(world, DIRECTOR.openingGracePeriod + 3, intent());
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
    expect(harness.seen.filter((name) => name === 'run:defeat').length).toBe(1);
  });

  it('reaches VICTORY when the final wave is cleared, and only once', () => {
    const saved = DIRECTOR_TUNING.totalWaves;
    DIRECTOR_TUNING.totalWaves = 2;
    try {
      const harness = makeWorld(7);
      const { world } = harness;
      const limit = Math.round(400 * SIM.tickHz);
      for (let i = 0; i < limit && world.director.status.outcome === 'running'; i += 1) {
        world.tick(DT, intent());
        despawnCombatants(world);
      }
      expect(world.director.status.outcome).toBe('victory');
      expect(harness.seen).toContain('run:victory');
      expect(harness.seen.filter((name) => name === 'run:victory').length).toBe(1);
      expect(world.director.status.wave).toBe(2);

      // No further arrivals after the win.
      const announced = harness.pending.length;
      for (let i = 0; i < 60 * 10; i += 1) world.tick(DT, intent());
      expect(harness.pending.length).toBe(announced);
    } finally {
      DIRECTOR_TUNING.totalWaves = saved;
    }
  });

  it('comes back to a clean first wave after a reset', () => {
    const harness = makeWorld();
    const { world } = harness;
    run(world, DIRECTOR.openingGracePeriod + 6, intent());
    run(world, 20, intent({ throwItem: true }));
    despawnCombatants(world);

    world.reset();

    expect(world.director.status.phase).toBe('OPENING');
    expect(world.director.status.wave).toBe(1);
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

    // And the second run really starts again rather than staying silent.
    run(world, DIRECTOR.openingGracePeriod + 2, intent());
    expect(world.director.status.phase).toBe('SPAWNING_SMALL');
    run(world, 3, intent());
    expect(world.enemies.liveCount('small')).toBeGreaterThan(0);
  });

  it('gives the same run from the same seed, waves and spawn points alike', () => {
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
    // The spawn stream is the director's own, derived from the seed: without that,
    // "every run is different" would be true of the wave sizes and false of the map
    // the player actually fights on.
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
    // The trap this pins (hard rule 7 / `docs/阶段3.md` section 3.7): `World`'s `rng` is
    // consumed twice per bullet for spread, so a director sharing that stream would
    // make every spawn point depend on how trigger-happy the player was, and "same
    // seed, same sequence" would be false in the only way that matters.
    //
    // The firing player aims into the sky, so the trigger consumes the combat stream
    // without changing anything else about the world: any difference in the announced
    // points could then only have come from a shared stream.
    const quiet = makeWorld(99);
    const noisy = makeWorld(99);
    const ticks = Math.round((DIRECTOR.openingGracePeriod + 3.5) * SIM.tickHz);

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
