/**
 * Damage pipeline.
 *
 * A single bullet's damage is a pure function of four things: the weapon's base
 * damage, which body part it struck, how far it travelled, and the victim's
 * armour. Keeping this a pure function (rather than a method on an enemy) is
 * what allows `tests/damage.test.ts` to assert the headline balance claim
 * directly — "22 base × 2.8 weak point × 1.0 falloff kills a 60 HP Stalker in
 * one shot" (61.6 ≥ 60), while the same 22 takes three body shots — with no
 * world, no renderer and no mocking.
 *
 * Order of operations is fixed and matters: weak point first (a reward for
 * precision), then falloff (a cost for distance), then armour (a property of the
 * victim). Applying armour before the multiplier would punish headshots on
 * armoured targets twice as hard, which is the opposite of the intent.
 */

import { ENEMY, WEAPON } from '../../core/config';
import { clamp } from '../../core/math/vec3';

/** Armour model for a damageable actor. */
export interface Armor {
  /**
   * Flat damage removed before the ratio is applied. Good against fast, weak
   * hits (a rifle) and nearly irrelevant against explosives.
   */
  readonly flatReduction: number;
  /**
   * Multiplier in `(0, 1]` applied after the flat reduction. Ignored entirely
   * when `bypassesArmor` is set — weak point hits do, which is what makes
   * precision the answer to an armoured target.
   */
  readonly ratio: number;
}

/** No armour at all. The default for practice targets. */
export const NO_ARMOR: Armor = { flatReduction: 0, ratio: 1 };

/** Everything the damage calculation needs to know about one hit. */
export interface DamageInput {
  /** Weapon base damage, before any mitigation. */
  readonly baseDamage: number;
  /** `head` multiplies by the victim's weak point multiplier. */
  readonly zone: 'head' | 'body';
  /** Multiplier the victim applies to weak point hits. */
  readonly weakPointMultiplier: number;
  /** Distance from the muzzle to the impact, in metres. */
  readonly distance: number;
  /** Half-angle of the spread cone the shot was fired with, in degrees. */
  readonly spreadDeg: number;
  readonly armor?: Armor;
  /** True for explosives and other sources that ignore armour. */
  readonly bypassesArmor?: boolean;
}

/** The decomposed result, kept for the debug readout and for tests. */
export interface DamageBreakdown {
  /** Weapon damage multiplied by the weak point multiplier. */
  readonly afterMultiplier: number;
  /** 1.0 inside `falloffStart`, decaying to `falloffMinScale` at `falloffEnd`. */
  readonly falloffScale: number;
  /** Damage after multiplier and falloff, before armour. */
  readonly beforeArmor: number;
  /** Damage removed by flat armour. */
  readonly armorAbsorbed: number;
  /** Final, non-negative damage. */
  readonly final: number;
}

/**
 * Distance falloff multiplier.
 *
 * Full damage out to `WEAPON.falloffStart`, then linear decay to
 * `WEAPON.falloffMinScale` at `WEAPON.falloffEnd`, and flat beyond that. Linear
 * (rather than exponential) because it must be explainable to a player: the
 * falloff band is short enough to learn by feel.
 */
export function damageFalloff(distance: number): number {
  const { falloffStart, falloffEnd, falloffMinScale } = WEAPON;
  if (distance <= falloffStart) return 1;
  if (distance >= falloffEnd) return falloffMinScale;
  const t = (distance - falloffStart) / (falloffEnd - falloffStart);
  return 1 + (falloffMinScale - 1) * t;
}

/**
 * Resolves one hit into its damage breakdown.
 *
 * Never returns zero for a hit that connected and passed armour: a bullet that
 * lands always does at least 1 point. A hit that reads as "0" is a bug report
 * ("I shot it and nothing happened") even when the maths is defensible.
 */
export function resolveDamage(input: DamageInput): DamageBreakdown {
  const weakPoint = input.zone === 'head' ? input.weakPointMultiplier : 1;
  const afterMultiplier = Math.max(0, input.baseDamage) * Math.max(0, weakPoint);

  const falloffScale = damageFalloff(input.distance);
  const beforeArmor = afterMultiplier * falloffScale;

  const armor = input.armor ?? NO_ARMOR;
  let armorAbsorbed = 0;
  let afterArmor = beforeArmor;
  if (!input.bypassesArmor) {
    armorAbsorbed = Math.min(armor.flatReduction, beforeArmor);
    afterArmor = (beforeArmor - armorAbsorbed) * clamp(armor.ratio, 0, 1);
  }

  return {
    afterMultiplier,
    falloffScale,
    beforeArmor,
    armorAbsorbed,
    final: Math.max(1, Math.ceil(afterArmor - 1e-9)),
  };
}

/**
 * Hitstop weight for one impact, in seconds.
 *
 * Three tiers keyed off the damage actually dealt, so a weak-point hit is
 * automatically heavier than a body shot without a second code path. The values
 * come from `HITSTOP` and are deliberately distinct: giving every hit the same
 * freeze is the single most common reason a shooter feels flat.
 */
export function hitstopForDamage(finalDamage: number, zone: 'head' | 'body', tiers: {
  light: number;
  medium: number;
  heavy: number;
  criticalBonus: number;
}): number {
  // Thresholds are in "fraction of the weapon's base damage" so they survive a
  // damage rebalance without becoming stale magic numbers.
  const relative = finalDamage / WEAPON.damage;
  let seconds: number;
  if (relative >= 2) seconds = tiers.heavy;
  else if (relative >= 1.5) seconds = tiers.medium;
  else seconds = tiers.light;
  if (zone === 'head') seconds += tiers.criticalBonus;
  return seconds;
}

/** What one hit does to the victim's velocity, and to its ability to act. */
export interface KnockbackBreakdown {
  /** Speed added along the shot direction, in m/s. Always non-negative. */
  readonly speed: number;
  /** Seconds the victim is held in hitstun. Zero for a hit below the threshold. */
  readonly stun: number;
}

/**
 * Knockback and hitstun for one hit.
 *
 * Damage-proportional, then divided by the victim's mass relative to a reference
 * body, so the same rifle round visibly staggers a 55 kg Stalker and does nothing
 * to a 900 kg Warden. Both facts are asserted in `tests/enemies.test.ts`; writing
 * the relationship rather than two per-archetype constants is what keeps them
 * from drifting apart during a rebalance.
 *
 * **Hitstun is gated on a damage *fraction*, not an absolute value**, and that
 * gate is the entire reason the two archetypes feel different to shoot: 22 damage
 * is 37% of a Stalker's health and 0.9% of a Warden's, so a rifle interrupts the
 * swarm and cannot interrupt the boss. The Warden's own stagger comes from
 * cumulative weak-point damage instead (see the enemy store), which is a
 * deliberate second mechanism rather than a different threshold.
 *
 * A `stun` of zero for a below-threshold hit is not a bug: constant micro-stun on
 * every bullet turns a pack of enemies into a row of statues.
 */
export function resolveKnockback(
  finalDamage: number,
  mass: number,
  maxHealth: number,
): KnockbackBreakdown {
  const damage = Math.max(0, finalDamage);
  const bodyMass = Math.max(1, mass);
  const reference = ENEMY.knockbackReferenceMass;
  const raw = damage * ENEMY.knockbackPerDamage * (reference / bodyMass);
  const speed = Math.min(ENEMY.knockbackMax, raw);

  const health = Math.max(1e-6, maxHealth);
  const stun = damage / health >= ENEMY.stunDamageFraction ? ENEMY.stunDuration : 0;
  return { speed, stun };
}

/**
 * The concurrent-attack budget for melee enemies.
 *
 * This is the single most important readability rule in the swarm encounter
 * (stage-2 brief section 1.6). Without it, eight Stalkers that arrive together all
 * strike inside the same half-second and the player experiences "I died
 * instantly" instead of "I mistimed my dodge". With it, three of them are the
 * threat and the rest hold the ring: the pressure is unchanged, the confusion is
 * not.
 *
 * Two properties this type is built around:
 *
 *   1. **The limit is never exceeded, and it is checked at claim time.** A refused
 *      claim leaves the enemy in CHASE. Nothing evicts a holder, because a holder
 *      is already mid-telegraph and cancelling it would retract a cue the player
 *      is in the middle of reacting to.
 *   2. **Rotation is by attacks *served*, not by refusals.** This distinction is
 *      the whole reason {@link AttackPriority} uses `served`. Counting refusals
 *      looks equivalent and is not: an enemy refused every tick accumulates an
 *      unbounded score while an enemy that has just attacked returns to zero, so
 *      the refused one can be starved indefinitely and the same few Stalkers fight
 *      the whole encounter. Counting completed attacks is bounded, monotone, and
 *      guarantees that whoever has swung least goes next.
 *
 * The tie-break is `(waitingSince, id)`, so the order is total and a seeded run
 * reproduces it exactly — no random draw, and no dependence on array order.
 */
export interface AttackSlots {
  /** Always `ATTACK_SLOTS`. Exposed so tests assert against the real limit. */
  readonly capacity: number;
  /** How many slots are currently held. */
  readonly used: number;
  /** True when `id` holds a slot right now. */
  has(id: number): boolean;
  /**
   * Attempts to take a slot for `id`.
   *
   * Returns `true` when the caller may attack — including when it already held a
   * slot, because re-asking while mid-attack is the normal case. Returns `false`
   * when the budget is full; the caller is expected to keep closing and ask again
   * next tick, which is what keeps the budget a behaviour rather than a counter.
   *
   * @param waitingSince Simulation time this enemy last became able to attack.
   */
  claim(id: number, waitingSince: number): boolean;
  /**
   * Returns a slot and credits one completed attack to `id`.
   *
   * The credit is what drives the rotation, so it must be called when the attack
   * *finishes* — not when the slot is taken and not when the enemy dies.
   * Idempotent, because a death mid-telegraph and a normal recovery can both
   * arrive in the same tick.
   */
  release(id: number, completed?: boolean): void;
  /** Round-robin ticket for one enemy. */
  priorityOf(id: number): AttackPriority;
  /** Every holder, for the debug overlay. */
  held(): readonly number[];
  reset(): void;
}

/** Round-robin ticket for one enemy competing for an attack slot. */
export interface AttackPriority {
  /** Completed attacks. Lower goes first; this is the fairness metric. */
  readonly served: number;
  /** Simulation time the enemy last became able to attack, for the tie-break. */
  readonly waitingSince: number;
}

/** Creates the melee attack-slot manager. */
export function createAttackSlots(capacity: number): AttackSlots {
  const limit = Math.max(1, Math.floor(capacity));
  const holders = new Set<number>();
  /** Completed attacks per enemy: the round-robin ticket. */
  const served = new Map<number, number>();
  /** When each enemy last became eligible, for the tie-break within a ticket. */
  const waiting = new Map<number, number>();

  return {
    get capacity() {
      return limit;
    },
    get used() {
      return holders.size;
    },

    has(id) {
      return holders.has(id);
    },

    claim(id, waitingSince) {
      // Keep the *oldest* recorded eligibility: refreshing it every tick would
      // make an enemy that has been waiting for seconds look like a fresh arrival
      // on every single tick, which is the opposite of what the tie-break is for.
      const previous = waiting.get(id);
      if (previous === undefined || waitingSince < previous) waiting.set(id, waitingSince);
      if (holders.has(id)) return true;
      if (holders.size >= limit) return false;
      holders.add(id);
      return true;
    },

    release(id, completed = true) {
      holders.delete(id);
      waiting.delete(id);
      // Only a finished attack counts. A slot released because the enemy died
      // mid-wind-up must not buy the *pool* a shorter turn next time it spawns —
      // ids are preserved across recycling, so that credit would follow the corpse.
      if (completed) served.set(id, (served.get(id) ?? 0) + 1);
    },

    priorityOf(id) {
      return { served: served.get(id) ?? 0, waitingSince: waiting.get(id) ?? Infinity };
    },

    held() {
      return [...holders];
    },

    reset() {
      holders.clear();
      served.clear();
      waiting.clear();
    },
  };
}

/**
 * Orders two enemies competing for an attack slot by "who is owed one most".
 *
 * Exported so the enemy layer can sort its candidates rather than asking in
 * arbitrary iteration order. `(fewer completed attacks, then longest wait, then
 * lowest id)` is a total order with no ties, so a seeded run is reproducible down
 * to which Stalker swings first.
 */
export function compareAttackPriority(
  a: AttackPriority & { readonly id: number },
  b: AttackPriority & { readonly id: number },
): number {
  if (a.served !== b.served) return a.served - b.served;
  if (a.waitingSince !== b.waitingSince) return a.waitingSince - b.waitingSince;
  return a.id - b.id;
}
