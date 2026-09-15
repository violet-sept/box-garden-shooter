/**
 * The single mutable world container.
 *
 * All game state lives here and advances in one direction: `tick(dt)` reads the
 * input intent, runs the systems in a fixed order, and writes nothing back to the
 * renderer. The presentation layer later calls {@link World.updateCamera} and
 * reads the state it needs; it never pushes state in. That one-way flow is what
 * makes the simulation replayable and testable.
 *
 * Tick order is load-bearing and is documented on {@link World.tick}. The short
 * version: time scale, weapon, player, aim, enemies, targets, shot, items, cleanup,
 * director. Anything that reads another system's output is scheduled after it, and
 * the four orderings that actually bite are called out on the tick itself:
 *
 *   - Enemy AI advances **before** the shot resolves, or every shot is fired at
 *     last tick's body positions and moving targets are permanently "a little
 *     off" (stage-2 trap table).
 *   - Enemy attacks resolve **after** the player has moved, so "where the player
 *     is this tick" and "whether they were hit this tick" describe one world
 *     state rather than two consecutive ones.
 *   - Thrown items resolve **after** `enemies.tick`/`enemies.sync`, because a blast
 *     reads this tick's body positions, and **before** cleanup, because an enemy
 *     killed by a blast has to go back to the pool through the same path as one
 *     killed by a bullet.
 *   - The director runs **after** cleanup, because `liveCount()` must not include
 *     the corpses this tick is about to recycle — otherwise the "wave cleared"
 *     test and the concurrency cap are both a tick stale.
 */

import { DIRECTOR, HITSTOP, ITEMS, SIM, type EnemyArchetypeId } from '../core/config';
import type { EventBus, EventSink } from '../core/events';
import type { InputIntent } from '../core/input';
import { createRng, seedFromString, type Rng } from '../core/math/rng';
import { type Vector3, clamp, copy } from '../core/math/vec3';
import { buildLevel, type LevelData } from './level';
import { createEnemyStore, type EnemyContext, type EnemyStore } from './enemies/EnemyStore';
import { createCombatSystem, type CombatSystem } from './combat/hitscan';
import {
  createCameraScratch,
  createCameraState,
  createAimSolution,
  solveAim,
  updateCamera as updateCameraRig,
  snapCamera,
  type AimSolution,
  type CameraState,
} from './camera/camera';
import {
  createCollisionWorld,
  createMovementScratch,
  createPlayerState,
  eyePosition,
  resetPlayerState,
  tickPlayer,
  type CollisionWorld,
  type MovementScratch,
  type PlayerState,
} from './player/player';
import {
  applyPlayerDamage,
  resetPlayerCombat,
  tickPlayerInvulnerability,
  tickPlayerRegen,
} from './player/combat';
import {
  applyRecoilImpulse,
  createWeaponState,
  resetWeaponState,
  tickRecoil,
  tickWeapon,
  type WeaponTickResult,
} from './player/weapon';
import { createDirector, type Director, type SpawnCommand, type DirectorContext } from './director/Director';
import { createItemSystem, type Explosion, type ItemSystem } from './items/throwable';

/** How the world is constructed. Everything injectable is injected. */
export interface WorldOptions {
  readonly events: EventBus;
  /** Simulation seed. Same seed, same level, same spread pattern, same waves. */
  readonly seed?: number;
  /** Overrides the level's own seed. Tests use it to pin a layout. */
  readonly levelSeed?: number;
  /** Starting throwable charges. Config default unless overridden. */
  readonly startingCharges?: number;
}

/** Rolling counters the debug panel shows. */
export interface WorldStats {
  /** Simulation ticks executed since the last reset. */
  ticks: number;
  /** Total simulated seconds. */
  elapsed: number;
  shotsFired: number;
  damageDealt: number;
  targetsKilled: number;
  /** Enemy attacks that connected, melee and barrage alike. */
  enemyHitsLanded: number;
  /** Damage the player has taken this life. */
  playerDamageTaken: number;
  /** Ticks during which the simulation ran at reduced time scale. */
  hitstopTicks: number;
  /** Items the player has thrown this run. */
  itemsThrown: number;
  /** Enemies caught by a blast, across every explosion. */
  blastHits: number;
}

/** A spawn that has been announced and is waiting for its warning to elapse. */
interface PendingSpawn {
  readonly orderId: number;
  readonly position: Vector3;
  readonly healthScale: number;
  readonly warning: number;
  /** True for the large enemy. */
  readonly boss: boolean;
  /** Why the large enemy was released; carried so `boss:spawned` can report it. */
  readonly bossReason: 'cleared' | 'timeout';
  /** Seconds of warning left. */
  remaining: number;
}

/** The world's public surface. */
export interface World {
  readonly player: PlayerState;
  readonly camera: CameraState;
  readonly level: LevelData;
  readonly collision: CollisionWorld;
  readonly enemies: EnemyStore;
  readonly combat: CombatSystem;
  readonly events: EventSink;
  readonly stats: WorldStats;
  /** The wave director, for the HUD and the debug panel to read. */
  readonly director: Director;
  /** The in-flight thrown items, for the render layer to draw. */
  readonly items: ItemSystem;
  /** Simulated seconds. */
  readonly time: number;
  /** The seed this run was built from, so a bug report can reproduce it. */
  readonly seed: number;
  /** Throwable charges. */
  charges: number;
  /** Advances the simulation by exactly one fixed tick. */
  tick(dt: number, intent: InputIntent): void;
  /** Recomputes the camera pose. Call once per rendered frame with a render dt. */
  updateCamera(dt: number): void;
  /**
   * Copies the current muzzle position into `out`.
   *
   * Exposed as methods rather than as a public `aim` object so the aim solution
   * stays private to the world: the renderer may *read* the shot frame, but it
   * must not be able to replace or half-update it.
   */
  muzzlePosition(out: Vector3): Vector3;
  /** Copies the current aim direction into `out`. */
  aimDirection(out: Vector3): Vector3;
  /** Clears every subsystem back to spawn state. */
  reset(): void;
  /** Fires the current weapon along the current aim solution. */
  fireOnce(): void;
  /** Throws an item along the current aim, if a charge and the cooldown allow. */
  throwOnce(): boolean;
}

/**
 * Creates the world.
 *
 * Construction is where the dependency graph gets wired, and it is wired in one
 * direction: level → collision/enemies → combat → player → camera. Nothing reaches
 * back up, which is why the enemy store is handed a `player:damaged` *event* rather
 * than a reference to the player.
 */
export function createWorld(options: WorldOptions): World {
  const { events } = options;
  const seed = options.seed ?? seedFromString('box-garden');
  const level = buildLevel(options.levelSeed);
  const collision = createCollisionWorld(level);
  const rng: Rng = createRng(seed);
  const enemies = createEnemyStore(level.targets, events);
  const combat = createCombatSystem({ world: { blockers: level.blockers }, targets: enemies, events, rng });

  const weapon = createWeaponState(seed ^ 0x9e37);
  const player = createPlayerState(weapon);
  const movementScratch: MovementScratch = createMovementScratch();
  const cameraScratch = createCameraScratch();
  const camera = createCameraState();
  const aim: AimSolution = createAimSolution();

  /**
   * The item system.
   *
   * Pooled, and deliberately *not* reset by `createWorld` alone: `reset()` clears it,
   * because a grenade in the air across a restart would detonate in the new run.
   */
  const items = createItemSystem();

  /**
   * The wave director's own random stream.
   *
   * Derived rather than shared with `combat`. The combat stream is consumed twice per
   * bullet for spread, so a shared stream would make spawn positions depend on how
   * many shots the player happened to fire — and the same seed would then produce two
   * different runs, which is exactly what "same seed, same sequence" forbids.
   */
  const director = createDirector({
    seed: seed ^ 0x51ed,
    events: {
      waveStarted(plan) {
        events.emit('wave:started', {
          tick: stats.ticks,
          wave: plan.wave + 1,
          smallCount: plan.smallCount,
          bossTimer: plan.bossTimer,
          breathing: plan.breathing,
        });
      },
      waveCleared(plan, reward) {
        events.emit('wave:cleared', { tick: stats.ticks, wave: plan.wave + 1, breathing: plan.breathing });
        if (reward > 0) charges = clamp(charges + reward, 0, ITEMS.maxCharges);
        // A clearing shot leaves bodies in the world that the player still has to
        // deal with; the banner says so rather than letting the next wave appear to
        // arrive early.
      },
      bossSpawned(order, reason) {
        // Recorded, not published: `boss:spawned` needs the enemy id, and the body
        // does not exist until the warning elapses. Publishing a placeholder id here
        // would make every subscriber's `byId` lookup fail.
        pendingBossReason.set(order.orderId, reason);
      },
      spawnPending(order, archetype) {
        events.emit('spawn:pending', {
          tick: stats.ticks,
          archetype,
          position: { x: order.position.x, y: order.position.y, z: order.position.z },
          warning: order.warning,
        });
      },
      runEnded(outcome) {
        if (outcome === 'victory') {
          events.emit('run:victory', { tick: stats.ticks, waves: director.status.wave, elapsed: time });
        } else {
          events.emit('run:defeat', { tick: stats.ticks, wave: director.status.wave, elapsed: time });
        }
      },
    },
  });

  const stats: WorldStats = {
    ticks: 0,
    elapsed: 0,
    shotsFired: 0,
    damageDealt: 0,
    targetsKilled: 0,
    enemyHitsLanded: 0,
    playerDamageTaken: 0,
    hitstopTicks: 0,
    itemsThrown: 0,
    blastHits: 0,
  };

  let time = 0;
  let charges = options.startingCharges ?? ITEMS.startingCharges;

  /**
   * Enemies whose warning is still running.
   *
   * The delay is the player's only notice that a patch of ground is about to become
   * dangerous, and it is why a spawn is a *place* rather than a surprise. The queue is
   * also where the concurrency cap gets its final say: the director bounds its own
   * in-flight orders, and this bounds what can actually exist.
   */
  const pending: PendingSpawn[] = [];
  /** Order id → why the large enemy was released, until the body appears. */
  const pendingBossReason = new Map<number, 'cleared' | 'timeout'>();
  /** Reused so the director tick allocates nothing. */
  const orders: SpawnCommand[] = [];
  /** Reused so the item tick allocates nothing. */
  const explosions: Explosion[] = [];

  /**
   * Hitstop budget in seconds.
   *
   * Implemented as a simulation time scale rather than skipped ticks (technical
   * plan section 3.4): the loop still runs every tick, so the accumulator and every
   * cadence accumulator inside it stay intact, and the FX/camera keep animating
   * while the world slows. Skipping ticks would make the reload timer and the fire
   * cadence jump on resume.
   */
  let hitstopRemaining = 0;

  /** Recoil to hand the camera, sampled at tick time and interpolated at render. */
  let recoilPitch = 0;
  let recoilYaw = 0;
  let prevRecoilPitch = 0;
  let prevRecoilYaw = 0;
  let lastTickDelta = 1 / SIM.tickHz;

  const refreshAim = (): void => {
    solveAim(aim, cameraScratch, player, collision.solids);
  };

  const handleWeaponEvents = (result: WeaponTickResult): void => {
    if (result.reloadStarted) {
      events.emit('weapon:reloadStarted', { tick: stats.ticks, duration: weapon.reloadDuration });
    }
    if (result.reloadFinished) {
      events.emit('weapon:reloadFinished', { tick: stats.ticks, empty: weapon.magazine === 0 });
    }
    if (result.reloadCancelled) {
      events.emit('weapon:reloadCancelled', { tick: stats.ticks });
    }
    if (result.magazineEmptied) {
      events.emit('weapon:magazineEmpty', { tick: stats.ticks });
    }
  };

  const performShot = (): void => {
    const result = combat.fire(aim.muzzle, aim.aimPoint, weapon.spreadDeg);
    stats.shotsFired += 1;
    stats.damageDealt += result.damageDealt;
    if (result.killed) stats.targetsKilled += 1;
    events.emit('shot:fired', {
      tick: stats.ticks,
      shotId: result.shotId,
      origin: { x: aim.muzzle.x, y: aim.muzzle.y, z: aim.muzzle.z },
      direction: { x: aim.direction.x, y: aim.direction.y, z: aim.direction.z },
      spreadDeg: result.spreadDeg,
    });
  };

  /**
   * Hitstop is created by the impact, so it is armed from the damage event rather
   * than from the shot. That way a shot that hits nothing does not slow the world
   * down, which is the difference between "impact" and "input lag".
   */
  events.on('hit:registered', (payload) => {
    if (HITSTOP.affectsPlayer) return;
    hitstopRemaining = Math.max(hitstopRemaining, payload.hitstop);
  });

  /**
   * Incoming damage.
   *
   * The enemy layer publishes the request and the world decides the outcome, which
   * is what keeps the dependency one way and puts i-frames, health clamping and
   * death in exactly one place. `applied` is used rather than re-reading
   * `player.health`, because an absorbed hit must not count as a landed one.
   */
  events.on('player:damaged', (payload) => {
    const result = applyPlayerDamage(player, payload.amount, payload.from, time);
    if (result.absorbed) return;
    stats.enemyHitsLanded += 1;
    stats.playerDamageTaken += result.applied;
    events.emit('player:stateChanged', { tick: stats.ticks, health: player.health });
    if (result.died) events.emit('player:died', { tick: stats.ticks });
  });

  /** The large enemy's death, published once, with the wave it belonged to. */
  events.on('enemy:died', (payload) => {
    if (payload.archetype !== 'large') return;
    events.emit('boss:died', { tick: stats.ticks, enemyId: payload.id, wave: director.status.wave });
  });

  const playerEye = { x: 0, y: 0, z: 0 };

  /** Empties the pending queue, telling the director nothing will arrive. */
  const dropPending = (): void => {
    for (const queued of pending) {
      director.abandonSpawn(queued.orderId);
      pendingBossReason.delete(queued.orderId);
    }
    pending.length = 0;
  };

  /** Turns the director's orders into queued warnings. */
  const queueOrders = (): void => {
    for (const order of orders) {
      pending.push({
        orderId: order.orderId,
        position: { x: order.position.x, y: order.position.y, z: order.position.z },
        healthScale: order.healthScale,
        warning: order.warning,
        boss: order.boss,
        bossReason: pendingBossReason.get(order.orderId) ?? 'cleared',
        remaining: order.warning,
      });
    }
  };

  /**
   * Counts the warning down and spawns whatever is due.
   *
   * The capacity check lives here rather than in the director because this is the
   * only place a body is actually created, and a cap enforced somewhere other than
   * where the thing happens is a cap that eventually gets bypassed. The director
   * applies the same limit to its own in-flight orders, so in practice nothing is
   * blocked here — this is the backstop, and it is what the concurrency assertion
   * actually reads.
   */
  const releaseDueSpawns = (dt: number): void => {
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const queued = pending[i];
      if (!queued) continue;
      // The run may have ended while the warning was running: `acceptsPending` is
      // then false, so the wave is cancelled rather than delivered onto a results
      // screen.
      if (!director.acceptsPending()) {
        dropPending();
        return;
      }
      queued.remaining -= dt;
      if (queued.remaining > 0) continue;
      const archetype: EnemyArchetypeId = queued.boss ? 'large' : 'small';
      if (!queued.boss && enemies.liveCount('small') >= DIRECTOR.maxConcurrentSmall) {
        // Saturated. The order is abandoned rather than retried: the director sees
        // that the wave has not progressed and issues another one when there is
        // room, which keeps it at one live order per body.
        pending.splice(i, 1);
        director.abandonSpawn(queued.orderId);
        continue;
      }
      pending.splice(i, 1);
      const spawned = enemies.spawn(archetype, queued.position, {
        healthScale: queued.healthScale,
        state: 'SPAWN',
      });
      director.confirmSpawn(queued.orderId);
      events.emit('enemy:spawned', {
        tick: stats.ticks,
        enemyId: spawned.id,
        archetype,
        position: { x: spawned.position.x, y: spawned.position.y, z: spawned.position.z },
      });
      if (queued.boss) {
        events.emit('boss:spawned', {
          tick: stats.ticks,
          enemyId: spawned.id,
          wave: director.status.wave,
          reason: queued.bossReason,
        });
      }
      pendingBossReason.delete(queued.orderId);
    }
  };

  /** Resolves the blasts the item system produced this tick. */
  const resolveExplosions = (): void => {
    for (const blast of explosions) {
      // `ownerId: 0` because no enemy ever has id 0, so a player item never skips a
      // target. The store's linear falloff, floor of 1 and outward knockback are
      // shared with the Warden's barrage on purpose: one blast rule, one place.
      const hits = enemies.applyBlast({
        ownerId: 0,
        position: blast.position,
        radius: blast.radius,
        damage: blast.damage,
      });
      stats.blastHits += hits;
      events.emit('item:exploded', {
        tick: stats.ticks,
        position: { x: blast.position.x, y: blast.position.y, z: blast.position.z },
        radius: blast.radius,
        hits,
      });
    }
    explosions.length = 0;
  };

  const world: World = {
    player,
    camera,
    level,
    collision,
    enemies,
    combat,
    events,
    stats,
    director,
    items,
    get time() {
      return time;
    },
    get seed() {
      return seed;
    },
    get charges() {
      return charges;
    },
    set charges(value: number) {
      charges = clamp(value, 0, ITEMS.maxCharges);
    },

    /**
     * One fixed simulation step.
     *
     * Order:
     *   1. Scale `dt` by the hitstop factor and decay the budget.
     *   2. Weapon decision: aim blend, cadence, reload progression.
     *   3. Player: look, movement, collision.
     *   4. Aim re-solve, so the muzzle is not a tick stale when the shot fires.
     *   5. Enemies: FSM, steering, attack clocks. Must precede step 7.
     *   6. Targets: rebuild every hitbox from this tick's positions.
     *   7. The shot: resolve rays and apply damage.
     *   8. Items: thrown-object integration, detonation and blast resolution.
     *   9. Cleanup: recycle dead enemies and release their attack slots.
     *  10. Director: wave state machine, pending spawns, victory and defeat.
     */
    tick(dt, intent) {
      stats.ticks += 1;
      lastTickDelta = dt;

      // --- 1. Time scale -----------------------------------------------------
      // A scale near zero means "fully frozen"; it ramps back to 1 over the
      // configured duration so the slowdown releases smoothly rather than snapping.
      let scaledDt = dt;
      if (hitstopRemaining > 0) {
        // Decay on real time, not scaled time, or the freeze would extend itself.
        hitstopRemaining = Math.max(0, hitstopRemaining - dt);
        scaledDt = dt * 0.12;
        stats.hitstopTicks += 1;
      }
      time += scaledDt;
      stats.elapsed = time;

      // --- 2. Weapon decision ------------------------------------------------
      const weaponResult = tickWeapon(
        weapon,
        { fire: intent.fire, aim: intent.aim, reloadPressed: intent.reload },
        scaledDt,
        time,
      );
      handleWeaponEvents(weaponResult);

      // --- 3. Player movement ------------------------------------------------
      tickPlayer(player, movementScratch, collision, intent, scaledDt, time);
      tickPlayerInvulnerability(player, scaledDt);
      tickPlayerRegen(player, scaledDt, time);

      // --- 3b. Throwing -------------------------------------------------------
      // Edge-triggered, so the intent flag can only ever be consumed once. The
      // charge is spent only when the item system actually accepted the throw, or a
      // throw on cooldown with an empty belt would silently eat a charge.
      if (intent.throwItem && !player.dead) {
        if (charges > 0 && items.throwFrom(player.position, player.yaw, player.pitch)) {
          charges -= 1;
          stats.itemsThrown += 1;
          events.emit('item:thrown', {
            tick: stats.ticks,
            position: { x: player.position.x, y: player.position.y, z: player.position.z },
            direction: { x: aim.direction.x, y: aim.direction.y, z: aim.direction.z },
            chargesLeft: charges,
          });
        }
      }

      // --- 4. Aim re-solve after movement ------------------------------------
      refreshAim();

      // --- 5. Enemies --------------------------------------------------------
      // AI advances here so that step 6 rebuilds hitboxes from *this* tick's
      // positions and step 7 fires at them. Doing it after the shot is the
      // "moving targets always miss by a little" failure.
      eyePosition(playerEye, player);
      const context: EnemyContext = {
        playerPosition: player.position,
        playerVelocity: player.velocity,
        playerAlive: !player.dead,
        time,
        dt: scaledDt,
        slots: enemies.attackSlots,
        collision,
        attacks: enemies.attacks,
      };
      enemies.tick(context);

      // --- 6. Targets --------------------------------------------------------
      enemies.sync(scaledDt, time);

      // --- 7. Shot -----------------------------------------------------------
      // Recoil ordering is deliberate: the impulse is accumulated by the shot,
      // the offset is captured for the camera *before* this tick's recovery is
      // applied, and recovery runs last so it can never eat into the climb the
      // player is about to fight.
      prevRecoilPitch = recoilPitch;
      prevRecoilYaw = recoilYaw;
      if (weaponResult.fired) {
        applyRecoilImpulse(weapon, weaponResult.recoilPitchDeg, weaponResult.recoilYawDeg);
        performShot();
      }
      const applied = tickRecoil(weapon, scaledDt);
      recoilPitch = applied.pitchDeg;
      recoilYaw = applied.yawDeg;

      // --- 8. Items ----------------------------------------------------------
      items.tick(scaledDt, collision.solids, explosions);
      resolveExplosions();

      // --- 9. Cleanup --------------------------------------------------------
      // Dead enemies are recycled in the same tick they die, so a corpse never
      // occupies a hitbox for a frame and never keeps an attack slot. The
      // `player:damaged` subscriber above has already released the slot for a
      // stun-interrupted attacker; this covers the death case.
      //
      // The test is `health > 0`, *not* `alive`: `applyDamage` sets `alive = false`
      // the moment health reaches zero, so a guard on `alive` would skip every
      // corpse and leave it in the store for ever. That is not a cosmetic leak --
      // it keeps the body in the hit query as a live target (so a shot can still be
      // "absorbed" by something that is already dead), it keeps the id in the
      // lookup, and it inflates every count that is derived from the array.
      //
      // Backwards, because `retire` swaps the last entry into the freed slot: a
      // forward loop can skip the entry it just moved (stage-2 finding C1).
      for (let i = enemies.targets.length - 1; i >= 0; i -= 1) {
        const enemy = enemies.targets[i];
        if (!enemy || enemy.health > 0) continue;
        enemies.despawn(enemy);
      }

      // --- 10. Director ------------------------------------------------------
      // After cleanup on purpose: `liveCount()` must describe the world the player
      // is about to see, not one that still contains this tick's corpses.
      orders.length = 0;
      const directorContext: DirectorContext = {
        tick: stats.ticks,
        time,
        dt: scaledDt,
        playerPosition: player.position,
        playerYaw: player.yaw,
        playerDead: player.dead,
        smallAlive: enemies.liveCount('small'),
        bossAlive: enemies.liveCount('large') > 0,
      };
      director.tick(directorContext, orders);
      queueOrders();
      releaseDueSpawns(scaledDt);
    },

    /**
     * Recomputes the camera for the frame being drawn.
     *
     * Called from the render callback, which is *not* a violation of "never
     * integrate in the render callback": the camera is presentation, it consumes
     * the simulation's authoritative yaw/pitch, and it writes nothing back. Its own
     * state (damped boom position) is derived, not simulated.
     */
    updateCamera(dt) {
      // Alpha-interpolate the recoil offset so 60 Hz recoil looks smooth at 144 Hz.
      const alpha = lastTickDelta > 0 ? clamp(dt / lastTickDelta, 0, 1) : 0;
      const pitch = prevRecoilPitch + (recoilPitch - prevRecoilPitch) * alpha;
      const yaw = prevRecoilYaw + (recoilYaw - prevRecoilYaw) * alpha;
      refreshAim();
      updateCameraRig(camera, player, aim, pitch, yaw, dt, collision.solids);
    },

    /** Fires immediately along the current aim. Used by tests and the debug panel. */
    fireOnce() {
      refreshAim();
      performShot();
    },

    /** Throws immediately along the current aim. Used by tests and the debug panel. */
    throwOnce() {
      refreshAim();
      if (player.dead || charges <= 0) return false;
      if (!items.throwFrom(player.position, player.yaw, player.pitch)) return false;
      charges -= 1;
      stats.itemsThrown += 1;
      events.emit('item:thrown', {
        tick: stats.ticks,
        position: { x: player.position.x, y: player.position.y, z: player.position.z },
        direction: { x: aim.direction.x, y: aim.direction.y, z: aim.direction.z },
        chargesLeft: charges,
      });
      return true;
    },

    muzzlePosition(out) {
      copy(out, aim.muzzle);
      return out;
    },

    aimDirection(out) {
      copy(out, aim.direction);
      return out;
    },

    reset() {
      resetPlayerState(player);
      resetPlayerCombat(player);
      resetWeaponState(weapon);
      enemies.reset();
      director.reset();
      items.clear();
      pending.length = 0;
      pendingBossReason.clear();
      orders.length = 0;
      explosions.length = 0;
      charges = options.startingCharges ?? ITEMS.startingCharges;
      time = 0;
      hitstopRemaining = 0;
      recoilPitch = 0;
      recoilYaw = 0;
      prevRecoilPitch = 0;
      prevRecoilYaw = 0;
      stats.ticks = 0;
      stats.elapsed = 0;
      stats.shotsFired = 0;
      stats.damageDealt = 0;
      stats.targetsKilled = 0;
      stats.enemyHitsLanded = 0;
      stats.playerDamageTaken = 0;
      stats.hitstopTicks = 0;
      stats.itemsThrown = 0;
      stats.blastHits = 0;
      refreshAim();
      snapCamera(camera, aim, player);
    },
  };

  refreshAim();
  snapCamera(camera, aim, player);
  return world;
}
