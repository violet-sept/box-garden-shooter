/**
 * Enemy state container and the shared FSM scaffolding.
 *
 * This is the phase-1 `Target` shape with three additions — an archetype, a state
 * field and an attack clock. That was the plan from the start (technical plan
 * section 3.2.5.1): the practice dummies were always the enemy store's
 * placeholder, so this is a substitution rather than a new architecture, and the
 * shot resolver's call surface does not move.
 *
 * Everything here is plain data. No meshes, no `three`, no timers. That is what
 * lets the entire enemy simulation — steering, frames, slots, death, cleanup —
 * run under Vitest in plain Node.
 */

import {
  ENEMY_HELICOPTER,
  ENEMY_LARGE,
  ENEMY_SMALL,
  ENRAGE_COOLDOWN_SCALE,
  ENRAGE_HEALTH_FRACTION,
  type EnemyStats,
  type EnemyArchetypeId,
} from '../../core/config';
import type { Vector3 } from '../../core/math/vec3';
import type { TargetHitbox } from '../combat/hitboxes';

/** Identifies a store entry. `dummy` is the non-combatant practice target. */
export type EnemyKind = EnemyArchetypeId | 'dummy';

/**
 * Small enemy states.
 *
 * `SPAWN` is a real state rather than an instant: an enemy that appears and
 * charges on the same tick gives the player no chance to register it, and the
 * director (phase 3) drives a materialisation beat with it.
 */
export type SmallState =
  | 'SPAWN'
  | 'IDLE'
  | 'CHASE'
  | 'TELEGRAPH'
  | 'ACTIVE'
  | 'RECOVER'
  | 'STAGGER'
  | 'DEAD';

/** Large enemy states. `REPOSITION` is the distance-band hold, not a chase. */
export type LargeState =
  | 'SPAWN'
  | 'IDLE'
  | 'REPOSITION'
  | 'TELEGRAPH'
  | 'SHOT'
  | 'RECOVER'
  | 'STAGGER'
  | 'ENRAGE'
  | 'DEAD';

/** Any state either FSM can be in. */
export type EnemyStateName = SmallState | LargeState;

/** Live state of one enemy (or practice dummy). */
export interface EnemyState {
  readonly id: number;
  readonly kind: EnemyKind;
  readonly stats: EnemyStats;
  /** Damage multiplier applied to weak-point hits on this body. */
  readonly weakPointMultiplier: number;
  /** Element 0 is always the head. Rebuilt each tick from `position`. */
  hitboxes: TargetHitbox[];
  /** Feet position. */
  readonly position: Vector3;
  /** Current velocity, m/s. Read by lead prediction and by the render layer. */
  readonly velocity: Vector3;
  /** Position at the start of the current tick, for render interpolation. */
  readonly previousPosition: Vector3;

  /** Current FSM state. Narrow per archetype at the point of use. */
  fsm: EnemyStateName;
  /** How long the FSM has been in `fsm`, in seconds. */
  stateTime: number;
  /** Seconds the current attack has been running, measured from the telegraph. */
  attackElapsed: number;
  /** Seconds until this enemy may begin another attack. */
  attackCooldown: number;
  /** True while this small enemy holds one of the `ATTACK_SLOTS` slots. */
  hasAttackSlot: boolean;
  /** True once the attack's damage has been resolved, so it lands exactly once. */
  attackResolved: boolean;

  health: number;
  alive: boolean;
  /** Simulation time of the last hit, for the flash effect. */
  lastHitTime: number;
  /** Accumulated damage, for the debug readout. */
  totalDamageTaken: number;
  /** Simulation time the last hit landed, used to rate-limit knockback. */
  lastKnockbackTime: number;
  /** Seconds of hitstun remaining. */
  stunRemaining: number;
  /** Time at which the enemy last decided a movement direction. */
  lastRepathTime: number;

  /** True once the large enemy has crossed its enrage threshold. */
  enraged: boolean;
  /** Weak-point damage accumulated since the last stagger (Warden only). */
  weakPointDamageSinceStagger: number;
  /**
   * The straight line the Warden's next shot would follow, rewritten every tick of the
   * wind-up.
   *
   * Kept on the state rather than in store-private storage because the render layer draws
   * it: the player's counterplay to a shot is to read this line and step off it, so it is
   * gameplay data, not decoration. It is also computed by the *same* function that fires
   * the shot, so the line the player watched and the line the bolt follows cannot differ by
   * anything except the last tick of tracking.
   */
  readonly aim: WardenAim;
  /**
   * The Warden's shots currently in the air.
   *
   * A straight ray each, with the direction frozen at the instant of firing. The store
   * advances them and resolves them against the player; the render layer reads their
   * positions to draw the bolts. Nothing here re-aims.
   */
  shots: WardenShot[];

  /** Presentation state, written by the AI and read by the view layer. */
  readonly view: EnemyViewState;
}

/**
 * The warning line for the Warden's shot.
 *
 * `length` is how far the line is drawn, in metres — to the player's own position rather
 * than to the configured range, because "this line goes through you" is the information the
 * warning carries. It is part of the aim solve rather than a render constant so the line the
 * player reads and the line the shot travels are produced by one piece of arithmetic.
 */
export interface WardenAim {
  readonly origin: Vector3;
  readonly direction: Vector3;
  length: number;
  /** True while the wind-up is running, i.e. while the line should be drawn. */
  active: boolean;
}

/** One shot in flight: a point moving along a line that never changes. */
export interface WardenShot {
  /** Where it left the Warden. Kept for the presentation layer's trail. */
  readonly origin: Vector3;
  /** Unit direction, **frozen at launch**. Nothing may write this after `fireShot`. */
  readonly direction: Vector3;
  /** Current position along the line. */
  readonly position: Vector3;
  /** Metres travelled since launch, against `WARDEN.shotRange`. */
  travelled: number;
  /** False once it has struck the player, hit cover, or run out of range. */
  alive: boolean;
}

/** Creates the (inactive) aim line for a freshly spawned large enemy. */
export function createWardenAim(): WardenAim {
  return {
    origin: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    length: 0,
    active: false,
  };
}

/** Everything the renderer needs that is not already geometric. */
export interface EnemyViewState {
  /** Facing, radians. 0 is -Z, matching the player convention. */
  yaw: number;
  /** 0..1 blend of the telegraph glow. */
  telegraphGlow: number;
  /** 0..1 blend of the white hit flash. */
  hitFlash: number;
  /** True while the body should read as "about to strike". */
  lunging: boolean;
}

/** Creates the mutable view-state block. */
export function createViewState(): EnemyViewState {
  return { yaw: 0, telegraphGlow: 0, hitFlash: 0, lunging: false };
}

/** Stats lookup for an archetype id. The one place archetype strings become stats. */
export function statsFor(kind: EnemyKind): EnemyStats {
  switch (kind) {
    case 'small':
      return ENEMY_SMALL;
    case 'large':
      return ENEMY_LARGE;
    case 'helicopter':
      return ENEMY_HELICOPTER;
    default:
      return ENEMY_SMALL;
  }
}

/**
 * Attack frame for an enemy, in seconds.
 *
 * Read straight off the archetype stats so the numbers stay in one table: an
 * attack window is a designer value, and a second copy of it here would be the
 * thing that silently fails to update when the balance is retuned.
 */
export function attackFrameFor(stats: EnemyStats): { telegraphTime: number; activeTime: number; recoveryTime: number } {
  return {
    telegraphTime: stats.telegraphTime,
    activeTime: stats.activeTime,
    recoveryTime: stats.recoveryTime,
  };
}

/** Cooldown scale applied to an enemy: enrage shortens it, nothing else does. */
export function cooldownScaleFor(enemy: EnemyState): number {
  return enemy.enraged ? ENRAGE_COOLDOWN_SCALE : 1;
}

/** True when the enemy is mid-attack and therefore not free to reposition. */
export function isAttacking(enemy: EnemyState): boolean {
  const state = enemy.fsm;
  return state === 'TELEGRAPH' || state === 'ACTIVE' || state === 'SHOT' || state === 'RECOVER';
}

/** True when a store entry is a live combatant rather than a practice dummy. */
export function isLiveEnemy(enemy: EnemyState): boolean {
  return enemy.kind === 'small' || isHeavy(enemy.kind);
}

/**
 * Whether an archetype is a **heavy**: the Warden or the gunship (phase 11).
 *
 * The two play by one rulebook — the same straight yellow shot, the same
 * weak-point stagger lever, the same enrage threshold — so every place that used to ask
 * `kind === 'large'` asks this instead. Retuning "how heavies work" is then one function
 * rather than a list of comparisons that have to be found and updated together, and the
 * gunship cannot end up as the one heavy that forgot to enrage.
 */
export function isHeavy(kind: EnemyKind): boolean {
  return kind === 'large' || kind === 'helicopter';
}

/**
 * Whether an archetype flies, i.e. holds its own altitude instead of standing on the floor.
 *
 * Read by the store's integrator (which skips the ground solve and the level-obstacle
 * push-out for these bodies) and by nothing else: "does this body obey gravity" is a
 * property of the archetype, not of a per-spawn flag some caller could forget to set.
 */
export function isFlying(kind: EnemyKind): boolean {
  return kind === 'helicopter';
}

/** Health at which the Warden enters `ENRAGE`. */
export const ENRAGE_HEALTH = ENEMY_LARGE.maxHealth * ENRAGE_HEALTH_FRACTION;
