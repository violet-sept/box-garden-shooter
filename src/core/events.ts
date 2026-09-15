/**
 * Typed event bus.
 *
 * The simulation never calls into presentation code. It publishes facts
 * ("a shot left the muzzle", "an enemy took 62 damage") and the presentation
 * layer subscribes. That inversion is what keeps `src/game/**` free of renderer
 * imports, and it is also what makes hit feedback observable: the same events
 * that spawn a tracer feed the `[HITLOG]` instrumentation, so "does the impact
 * land on the frame it should" becomes a reading rather than an opinion.
 *
 * Subscriber failures are swallowed on purpose. A thrown exception inside a
 * decal spawner must not take down the tick that produced it — the simulation is
 * authoritative, the presentation is optional.
 */

import type { Vector3 } from './math/vec3';
import type { EnemyArchetypeId } from './config';

/** Which part of a hitbox was struck, which selects the damage multiplier. */
export type HitZone = 'head' | 'body';

/** What a bullet or blast landed on, which selects the impact effect. */
export type SurfaceKind = 'concrete' | 'metal' | 'crate' | 'target' | 'ground';

/** Event names and their payloads. Adding an event means adding it here. */
export interface GameEvents {
  'shot:fired': {
    /** Tick index the shot was simulated on, for frame-alignment checks. */
    tick: number;
    shotId: number;
    origin: Vector3;
    direction: Vector3;
    /** Spread cone half-angle actually used, in degrees. */
    spreadDeg: number;
  };
  'bullet:impact': {
    tick: number;
    shotId: number;
    point: Vector3;
    normal: Vector3;
    surface: SurfaceKind;
    distance: number;
  };
  'bullet:miss': {
    tick: number;
    shotId: number;
    /** Far end of the trace, used to draw the full-length tracer. */
    end: Vector3;
  };
  'hit:registered': {
    tick: number;
    shotId: number;
    /** Target id, or 0 when the surface is not a damageable body. */
    targetId: number;
    zone: HitZone;
    /** Bullet damage before any multiplier. */
    baseDamage: number;
    /** Damage actually dealt, after weak point and falloff. */
    finalDamage: number;
    distance: number;
    point: Vector3;
    /** Hitstop applied for this impact, in seconds. */
    hitstop: number;
  };
  'target:damaged': {
    tick: number;
    targetId: number;
    amount: number;
    zone: HitZone;
    remaining: number;
    max: number;
    point: Vector3;
  };
  'target:died': {
    tick: number;
    targetId: number;
    position: Vector3;
  };
  /**
   * An enemy lost health.
   *
   * Renamed from `target:damaged` in phase 2. The rename was free at exactly this
   * moment — practice targets and enemies are the same repository now, and no
   * subscriber ever read the old name — and it is deliberate that only one name
   * fires. Publishing both would create two sources of truth for "an enemy was
   * hit", and the two would inevitably drift.
   */
  'enemy:damaged': {
    tick: number;
    id: number;
    archetype: EnemyArchetypeId;
    amount: number;
    zone: HitZone;
    remaining: number;
    max: number;
    point: Vector3;
    /** Knockback speed applied along `direction`, in m/s. */
    knockback: number;
    /** Unit direction the knockback pushed along. */
    direction: Vector3;
  };
  'enemy:died': {
    tick: number;
    id: number;
    archetype: EnemyArchetypeId;
    position: Vector3;
    scoreValue: number;
  };
  /**
   * An enemy entered a telegraph window.
   *
   * Separate from the damage events because the presentation layer needs the
   * *start* of the wind-up in order to light it up: this is the only cue the player
   * gets, and deriving it by polling the FSM from the render callback would put a
   * frame of latency on the one thing the whole readability budget is spent on.
   *
   * Emitted **once** per attack now. It used to be emitted twice for the Warden, the
   * second time carrying the locked blast points a third of a second before they went
   * off; the shot has no ground markers to lock, so the second emission became a
   * duplicate and was removed. "The bolt is away" is `enemy:shot` instead — a different
   * fact with its own name, rather than one name meaning two things.
   */
  'enemy:telegraph': {
    tick: number;
    id: number;
    archetype: EnemyArchetypeId;
    kind: 'melee' | 'shot';
    /** Simulation time the telegraph ends and damage becomes possible. */
    until: number;
  };
  /**
   * An enemy's attack connected with the player.
   *
   * Published *before* the damage is applied, and carrying the raw amount rather
   * than a result: whether the hit lands is the player's business (i-frames,
   * health clamping, death), and the enemy layer must not be able to decide it.
   * The world subscribes and applies it, which also keeps the dependency running
   * one way — enemies emit, the world owns the player.
   */
  'player:damaged': {
    tick: number;
    amount: number;
    /** Where the damage came from, for directional feedback. */
    from: Vector3;
    /** 'melee' for a contact swing, 'shot' for the Warden's straight line. */
    source: 'melee' | 'shot';
  };
  /**
   * The Warden fired its shot: one straight line, direction now frozen.
   *
   * Carries the origin and direction so the presentation layer can draw the bolt
   * without reaching into the simulation, and so the report sound lands on the tick
   * the trigger was pulled rather than a frame later.
   */
  'enemy:shot': {
    tick: number;
    enemyId: number;
    origin: Vector3;
    direction: Vector3;
  };
  /**
   * A Warden shot's line ended — on the player, on cover, or at the end of its range.
   *
   * One event for all three ends because they are one fact ("that line is over"), with the
   * end point published so the flash is drawn exactly where the damage was resolved.
   * `hitPlayer` is what separates "it went through me" from "it stopped at the crate":
   * the impact sound is only for the former, while the yellow flash is for both.
   */
  'enemy:shotEnded': {
    tick: number;
    enemyId: number;
    /** Where the line ended. */
    position: Vector3;
    /** Radius of the shot, so the flash is the size of the thing that hit. */
    radius: number;
    /** True when the line ended on the player, i.e. when damage was published. */
    hitPlayer: boolean;
  };
  'player:died': { tick: number };
  'weapon:reloadStarted': { tick: number; duration: number };
  'weapon:reloadFinished': { tick: number; empty: boolean };
  'weapon:reloadCancelled': { tick: number };
  'weapon:magazineEmpty': { tick: number };
  'player:stateChanged': { tick: number; health: number };
  'player:adsChanged': { tick: number; aiming: boolean };
  'debug:enabled': { enabled: boolean };

  // --- Wave director (phase 3) ----------------------------------------------
  //
  // Every one of these carries `tick`. The `[HITLOG]` tolerance checks and the
  // cross-shot crosstalk filter both key off it, and a run event without a tick is
  // impossible to line up against the shot log that explains it.
  'wave:started': {
    tick: number;
    /** 1-based wave number, for the HUD. The director's index is 0-based. */
    wave: number;
    smallCount: number;
    bossTimer: number;
    breathing: boolean;
  };
  'wave:cleared': { tick: number; wave: number; breathing: boolean };
  /**
   * An enemy is about to appear at `position`.
   *
   * Published `DIRECTOR.spawnWarningDuration` before the spawn, which is the
   * player's only warning that somewhere is about to become dangerous — the
   * counterpart of `enemy:telegraph`, and separately tunable from it on purpose.
   */
  'spawn:pending': {
    tick: number;
    archetype: EnemyArchetypeId;
    position: Vector3;
    /** Seconds until the enemy appears. */
    warning: number;
  };
  /** The enemy announced by `spawn:pending` is now in the world. */
  'enemy:spawned': { tick: number; enemyId: number; archetype: EnemyArchetypeId; position: Vector3 };
  /**
   * The large enemy was released.
   *
   * One event with a `reason`, not two events. Both causes are the same fact —
   * "the wave's large enemy is now active" — and two names would mean two
   * subscription sites, one of which would eventually miss a fix.
   */
  'boss:spawned': {
    tick: number;
    enemyId: number;
    wave: number;
    reason: 'cleared' | 'timeout';
  };
  'boss:died': { tick: number; enemyId: number; wave: number };
  'item:thrown': { tick: number; position: Vector3; direction: Vector3; chargesLeft: number };
  'item:exploded': { tick: number; position: Vector3; radius: number; hits: number };
  /**
   * The run ended. Published once, and afterwards the director stops spawning.
   *
   * `elapsed` is the run's simulated seconds, which is what the results screen
   * reports and what makes "a run is 10-15 minutes" a reading rather than a claim.
   */
  'run:victory': { tick: number; waves: number; elapsed: number };
  'run:defeat': { tick: number; wave: number; elapsed: number };
}

export type GameEventName = keyof GameEvents;
export type GameEventPayload<K extends GameEventName> = GameEvents[K];
export type GameEventHandler<K extends GameEventName> = (payload: GameEvents[K]) => void;

/** The publish/subscribe surface the simulation is given. */
export interface EventSink {
  emit<K extends GameEventName>(name: K, payload: GameEvents[K]): void;
}

/** A sink that discards everything. Used by tests that do not assert on events. */
export const nullEventSink: EventSink = {
  emit() {
    /* intentionally empty */
  },
};

interface Subscription {
  readonly handler: (payload: never) => void;
}

/**
 * The concrete bus.
 *
 * Not a class per-event map with wildcards and priorities — it is intentionally
 * the smallest thing that works: a `Map` of name to handler set, plus an
 * error-isolating dispatch. Anything fancier would be architecture for its own
 * sake at this entity count.
 */
export class EventBus implements EventSink {
  private readonly handlers = new Map<GameEventName, Set<Subscription>>();
  /** When true, handler exceptions are rethrown instead of swallowed. Tests use it. */
  constructor(private readonly strict = false) {}

  on<K extends GameEventName>(name: K, handler: GameEventHandler<K>): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    const subscription: Subscription = { handler: handler as (payload: never) => void };
    set.add(subscription);
    return () => {
      set.delete(subscription);
    };
  }

  once<K extends GameEventName>(name: K, handler: GameEventHandler<K>): () => void {
    const off = this.on(name, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  emit<K extends GameEventName>(name: K, payload: GameEvents[K]): void {
    const set = this.handlers.get(name);
    if (!set || set.size === 0) return;
    // Iterate a copy: a handler is allowed to unsubscribe itself.
    for (const subscription of [...set]) {
      try {
        (subscription.handler as GameEventHandler<K>)(payload);
      } catch (error) {
        if (this.strict) throw error;
        // A broken effect must never break the tick that produced it.
        console.error(`[events] handler for "${name}" threw`, error);
      }
    }
  }

  /** Drops every subscription. Called on teardown. */
  clear(): void {
    this.handlers.clear();
  }

  /** Number of subscribers for a name. Test/diagnostic helper. */
  listenerCount(name: GameEventName): number {
    return this.handlers.get(name)?.size ?? 0;
  }
}
