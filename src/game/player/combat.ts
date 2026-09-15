/**
 * Taking damage.
 *
 * The player used to have `health` and nothing that could reduce it. This adds
 * the three rules that make incoming damage survivable rather than a stunlock:
 *
 *   1. **Invulnerability frames.** `PLAYER.hitInvulnerability` seconds after any
 *      hit, during which further hits are absorbed silently. Without this, a pack
 *      of Stalkers landing 9 damage each inside 0.3 s deals 54 damage in a blink,
 *      which reads as "I died instantly" and is the exact complaint the
 *      `ATTACK_SLOTS` budget also exists to prevent. The two are complementary:
 *      slots cap how many enemies *swing*, i-frames cap how fast damage *lands*.
 *   2. **Regeneration after a delay.** `regenDelay` seconds of not being hit, then
 *      `regenRate` health a second. This is what makes retreating a real decision
 *      instead of a slower death.
 *   3. **A damage direction.** The HUD's vignette and, later, the audio need to
 *      know where the hit came from. A flat "you lost 9 health" cannot tell the
 *      player to turn around.
 *
 * Pure functions over `PlayerState`: no events, no store, no renderer. The caller
 * emits; this decides.
 */

import { PLAYER } from '../../core/config';
import { type Vector3, clamp, copy } from '../../core/math/vec3';
import type { PlayerState } from './player';

/** What one incoming hit did, after i-frames and clamping. */
export interface PlayerDamageResult {
  /** Damage actually removed from health. Zero when i-frames absorbed the hit. */
  readonly applied: number;
  /** True when the hit was ignored because the player was invulnerable. */
  readonly absorbed: boolean;
  /** True on the transition to dead, so the caller emits exactly once. */
  readonly died: boolean;
}

/** Adds the damage bookkeeping the controller needs. Called before first use. */
export function initPlayerCombat(state: PlayerState): void {
  state.invulnerableFor = 0;
  state.lastDamageTime = -Infinity;
  state.lastDamageFrom.x = 0;
  state.lastDamageFrom.y = 0;
  state.lastDamageFrom.z = 0;
  state.damageTaken = 0;
  state.dead = false;
}

/**
 * Applies incoming damage, honouring i-frames.
 *
 * @param time Simulation seconds, used for the regeneration delay.
 * @param from Where the damage came from, for directional feedback.
 */
export function applyPlayerDamage(
  state: PlayerState,
  amount: number,
  from: Vector3,
  time: number,
): PlayerDamageResult {
  if (state.dead || amount <= 0) return { applied: 0, absorbed: true, died: false };
  if (state.invulnerableFor > 0) return { applied: 0, absorbed: true, died: false };

  const applied = Math.min(state.health, amount);
  state.health = Math.max(0, state.health - amount);
  state.damageTaken += applied;
  state.lastDamageTime = time;
  state.invulnerableFor = PLAYER.hitInvulnerability;
  copy(state.lastDamageFrom, from);

  if (state.health > 0) return { applied, absorbed: false, died: false };
  state.dead = true;
  return { applied, absorbed: false, died: true };
}

/**
 * Advances i-frames tick by tick, so it is called once per simulation step.
 *
 * Kept separate from the damage call because i-frames must decay on *simulation*
 * time: decaying them on render time would make the window frame-rate dependent,
 * which is the whole class of bug the fixed-timestep loop exists to prevent.
 */
export function tickPlayerInvulnerability(state: PlayerState, dt: number): void {
  if (state.invulnerableFor > 0) {
    state.invulnerableFor = Math.max(0, state.invulnerableFor - dt);
  }
}

/**
 * Health regeneration.
 *
 * Regenerates only after `regenDelay` seconds without a hit, and only while the
 * player is alive. The delay is measured from `lastDamageTime`, which starts at
 * negative infinity so a fresh spawn is treated as "long since last hit" rather
 * than as "never hit, so never regenerate".
 */
export function tickPlayerRegen(state: PlayerState, dt: number, time: number): void {
  if (state.dead || state.health >= state.maxHealth) return;
  if (time - state.lastDamageTime < PLAYER.regenDelay) return;
  state.health = clamp(state.health + PLAYER.regenRate * dt, 0, state.maxHealth);
}

/** Restores the combat bookkeeping to spawn condition. */
export function resetPlayerCombat(state: PlayerState): void {
  initPlayerCombat(state);
}

/**
 * The player's damage capsule, as an axis-aligned box.
 *
 * Contact melee is tested as a sphere against this box rather than as a ray: a
 * ray can slip past a body that visibly touched the enemy, and "it clearly
 * reached me and nothing happened" is a worse failure than being hit by a swing
 * that only nearly connected. The box is deliberately a little wider than the
 * movement capsule (`PLAYER_HURTBOX_RADIUS`), for the same reason.
 */
export function playerHurtbox(out: { center: Vector3; halfExtents: Vector3 }, state: PlayerState, radius: number): void {
  out.center.x = state.position.x;
  out.center.y = state.position.y + PLAYER.height * 0.5;
  out.center.z = state.position.z;
  out.halfExtents.x = radius;
  out.halfExtents.y = PLAYER.height * 0.5;
  out.halfExtents.z = radius;
}
