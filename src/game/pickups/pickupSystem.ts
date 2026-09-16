/**
 * Supply crates: the ammo box and the medkit (phase 11).
 *
 * Simulation layer only — no `three`, not even for a vector (hard rule 1). The render layer
 * draws what this produces by reading {@link Pickup} positions, exactly the way it reads
 * thrown items.
 *
 * ## The rule, and why it is this short
 *
 * The brief is four sentences long and every one of them is here rather than spread over the
 * callers: both kinds refresh **together**, one of each per beat; the beat is
 * `PICKUPS.refreshInterval` seconds and the first beat is the run's first tick; a kind that
 * is already at `PICKUPS.maxPerKind` on the field is **skipped** — and therefore resumes by
 * itself on a later beat once the player has taken one — and a new crate never lands on top
 * of one that is already there.
 *
 * The refresh schedule is **absolute** (`nextRefreshAt += interval`), for the same reason
 * the director's drop times are: a long frame or a hitstop can delay when a beat is
 * *noticed*, never which second it belongs to. And because the cap is checked when the beat
 * fires rather than continuously, "at the cap" means "skipped this beat", which is exactly
 * the brief's "达到并维持在最大数量后不再刷新，不是最大数量时恢复刷新".
 *
 * ## Why placement is a rejection sampler with a guaranteed fallback
 *
 * "A random part of the map" has to satisfy four things at once (inside the arena and clear
 * of the fence, not inside level geometry, not inside the player, and not on top of another
 * crate), and a first-match loop over random points can fail — which would mean a beat with
 * no delivery, and the brief does not allow that ("间隔二十秒再次刷新"). So every candidate
 * is scored by how much room it has, the best one is remembered, and it is used if nothing
 * passes outright. A crate in a slightly tighter spot is a much smaller problem than a crate
 * that never arrives.
 */

import { PICKUPS, type PickupKind } from '../../core/config';
import { createRng, type Rng } from '../../core/math/rng';
import { type Aabb, type Vector3, distanceXZ, set } from '../../core/math/vec3';

/** The kinds, in refresh order. One of each is attempted per beat. */
export const PICKUP_KINDS: readonly PickupKind[] = ['ammo', 'medkit'];

/** One crate on the field. Plain data: the render layer reads it and nothing else writes it. */
export interface Pickup {
  /** Unique while alive. Ids are never reused, so a view can key off them. */
  id: number;
  kind: PickupKind;
  /** True while this slot holds a crate the player can still take. */
  active: boolean;
  /** Centre of the crate. It sits on the floor, so `y` is half its own edge length. */
  readonly position: Vector3;
}

/** Everything a refresh needs to know about the world it is placing into. */
export interface PickupSpawnContext {
  /** Where the player is, so a crate never materialises in their lap. */
  readonly playerPosition: Vector3;
  /**
   * Solid level geometry.
   *
   * The same list the player and the bullets use, so "the crate is not inside a wall" is
   * decided against the things the player can see rather than against a second derivation.
   * The ground slab is in here too and is handled by the overlap test being strict: the slab
   * tops out exactly at y = 0 and a crate starts exactly at y = 0.
   */
  readonly obstacles: readonly Aabb[];
  /** Arena half-extent. */
  readonly halfSize: number;
}

/** The crate system's public surface. */
export interface PickupSystem {
  /** Every slot, active or not. The render layer reads this and nothing else. */
  readonly pickups: readonly Pickup[];
  /**
   * Advances the refresh clock by one fixed step and appends this tick's new crates to `out`.
   *
   * Appended rather than resolved here because "a crate appeared" is announced as an event by
   * the world, and keeping that boundary is what lets this module run in a test with no world
   * at all.
   */
  tick(dt: number, context: PickupSpawnContext, out: Pickup[]): void;
  /**
   * The crate `E` would use right now, or `null`.
   *
   * Two callers with one rule: the world asks it to perform the interaction, and the HUD asks
   * it to decide whether to show the prompt. A second "is anything in range" implementation
   * is how a prompt ends up offering a crate the key cannot reach.
   */
  nearest(position: Vector3): Pickup | null;
  /** Uses the crate `nearest` would return: it is retired and handed back, or `null`. */
  collect(position: Vector3): Pickup | null;
  /**
   * Live crates, of one kind or of both.
   *
   * The cap is checked with a kind and the debug panel asks for the total, which is the same
   * count with a different question — so one method answers both rather than a per-kind
   * counter plus a sum that could drift from it.
   */
  liveCount(kind?: PickupKind): number;
  /** Retires every crate and re-arms the schedule. Called on a run restart. */
  reset(): void;
}

/** Options for {@link createPickupSystem}. */
export interface PickupSystemOptions {
  /** Seed for the placement stream. Derived from the run's seed by the world. */
  readonly seed: number;
}

/**
 * Creates the crate system.
 *
 * The random stream is its own, for the same reason the director's is: sharing one with
 * combat would make crate positions depend on how many shots the player happened to fire,
 * and the same seed would then produce two different runs.
 */
export function createPickupSystem({ seed }: PickupSystemOptions): PickupSystem {
  const pool: Pickup[] = [];
  let rng: Rng = createRng(seed);
  let nextId = 1;
  let elapsed = 0;
  let nextRefreshAt: number = PICKUPS.firstRefreshAt;

  /** A slot for a new crate, reusing a retired one when there is one. */
  const acquire = (): Pickup => {
    for (const slot of pool) {
      if (!slot.active) return slot;
    }
    const slot: Pickup = { id: nextId++, kind: 'ammo', active: false, position: { x: 0, y: 0, z: 0 } };
    pool.push(slot);
    return slot;
  };

  const liveCount = (kind?: PickupKind): number => {
    let count = 0;
    for (const slot of pool) {
      if (!slot.active) continue;
      if (kind !== undefined && slot.kind !== kind) continue;
      count += 1;
    }
    return count;
  };

  /**
   * The crate `E` would reach from `position`, or `null`.
   *
   * A plain function rather than two methods with one of them calling `this.nearest(...)`:
   * a detached method reference is a real failure this project has already shipped once
   * (`attachAudio`), and a shared local has no receiver to lose.
   */
  const nearestSlot = (position: Vector3): Pickup | null => {
    let best: Pickup | null = null;
    // Annotated rather than inferred: `PICKUPS` is `as const`, so inferring would give this
    // variable the literal type of the configured range and refuse every distance written
    // into it afterwards.
    let bestDistance: number = PICKUPS.interactRange;
    for (const slot of pool) {
      if (!slot.active) continue;
      const distance = distanceXZ(position, slot.position);
      if (distance > bestDistance) continue;
      bestDistance = distance;
      best = slot;
    }
    return best;
  };

  /** Whether a crate centred here would be inside a piece of level geometry. */
  const insideGeometry = (x: number, y: number, z: number, obstacles: readonly Aabb[]): boolean => {
    const half = PICKUPS.size * 0.5;
    for (const box of obstacles) {
      // Strict on every axis: touching is not overlapping, and the ground slab's top face is
      // exactly the crate's bottom face.
      if (Math.abs(x - box.center.x) >= box.halfExtents.x + half) continue;
      if (Math.abs(y - box.center.y) >= box.halfExtents.y + half) continue;
      if (Math.abs(z - box.center.z) >= box.halfExtents.z + half) continue;
      return true;
    }
    return false;
  };

  /**
   * Chooses where the next crate goes.
   *
   * Returns the best candidate found, which is only *forced* when nothing satisfied every
   * rule. See the module header for why a guaranteed answer matters more than a perfect one.
   */
  const choosePosition = (context: PickupSpawnContext, out: Vector3): void => {
    const half = PICKUPS.size * 0.5;
    const limit = Math.max(half, context.halfSize - PICKUPS.fenceMargin - half);
    const y = half;
    let bestX = 0;
    let bestZ = 0;
    let bestClearance = -Infinity;

    for (let attempt = 0; attempt < PICKUPS.placementAttempts; attempt += 1) {
      // Written into the scratch vector rather than into a fresh literal: one refresh a
      // second would be nothing, but this loop is `placementAttempts` iterations and the
      // simulation's allocation rule does not have a "rare enough" exemption in it.
      set(candidate, rng.range(-limit, limit), y, rng.range(-limit, limit));
      const x = candidate.x;
      const z = candidate.z;

      // Closest existing crate. Tracked for every candidate because it is also the fallback's
      // score: the tightest legal-ish spot still beats a crate inside another crate.
      let clearance = Infinity;
      for (const slot of pool) {
        if (!slot.active) continue;
        const distance = distanceXZ(candidate, slot.position);
        if (distance < clearance) clearance = distance;
      }

      const tooCloseToCrate = clearance < PICKUPS.minSeparation;
      const tooCloseToPlayer = distanceXZ(candidate, context.playerPosition) < PICKUPS.minDistanceFromPlayer;
      const blocked = insideGeometry(x, y, z, context.obstacles);

      if (!tooCloseToCrate && !tooCloseToPlayer && !blocked) {
        set(out, x, y, z);
        return;
      }
      if (blocked) continue;
      if (clearance > bestClearance) {
        bestClearance = clearance;
        bestX = x;
        bestZ = z;
      }
    }

    set(out, bestX, y, bestZ);
  };

  /** Placement scratch, so a refresh allocates nothing. */
  const candidate: Vector3 = { x: 0, y: 0, z: 0 };
  const spot: Vector3 = { x: 0, y: 0, z: 0 };

  const refresh = (context: PickupSpawnContext, out: Pickup[]): void => {
    for (const kind of PICKUP_KINDS) {
      // At the cap this kind is skipped for **this beat**, and the check is repeated next
      // beat: that is the whole of "stop refreshing at the cap, resume below it", with no
      // second state machine and nothing to reset when the player takes one.
      if (liveCount(kind) >= PICKUPS.maxPerKind) continue;
      choosePosition(context, spot);
      const slot = acquire();
      slot.kind = kind;
      slot.active = true;
      set(slot.position, spot.x, spot.y, spot.z);
      out.push(slot);
    }
  };

  return {
    pickups: pool,

    tick(dt, context, out) {
      elapsed += dt;
      // Absolute schedule, and a `while` rather than an `if` for the same reason the
      // director's drops use one: the beat a refresh belongs to is a property of the
      // schedule, not of the tick rate.
      const interval = PICKUPS.refreshInterval > 0 ? PICKUPS.refreshInterval : Infinity;
      while (elapsed >= nextRefreshAt) {
        refresh(context, out);
        nextRefreshAt += interval;
      }
    },

    nearest(position) {
      return nearestSlot(position);
    },

    collect(position) {
      const slot = nearestSlot(position);
      if (!slot) return null;
      slot.active = false;
      return slot;
    },

    liveCount,

    reset() {
      for (const slot of pool) {
        slot.active = false;
        set(slot.position, 0, 0, 0);
      }
      rng = createRng(seed);
      elapsed = 0;
      nextRefreshAt = PICKUPS.firstRefreshAt;
    },
  };
}
