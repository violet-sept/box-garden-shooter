/**
 * Thrown items: the arc, the bounces, the fuse and the blast.
 *
 * Simulation layer only — no `three`, not even for a vector (hard rule 1). The
 * renderer draws what this produces by reading {@link Throwable} positions.
 *
 * ## Why the trajectory is analytic instead of physics
 *
 * There is no physics engine in this project on purpose (technical plan section
 * 2.1): the only rigid-body need is one grenade, and a fixed-timestep semi-implicit
 * Euler integration of `v += g dt; x += v dt` is both shorter than a broadphase and
 * exactly reproducible from a seed. The one property that matters is that the arc
 * is *frame-rate independent*: the position after `t` seconds is a function of `t`
 * and the launch velocity alone, because each step's update uses the velocity from
 * the start of that step. Subdividing a second into 30 or 120 steps therefore lands
 * the grenade in the same place, which is what makes "the throw goes where you aimed
 * it" testable rather than anecdotal.
 *
 * ## Pooling
 *
 * The pool is built once and driven by an `active` flag (hard rule 8). A thrown
 * object owns a geometry-sized mesh in the render layer, which is more expensive
 * than a particle, so "new one per throw" is more costly here than anywhere else in
 * the FX budget.
 */

import { ITEMS, PLAYER, SIM } from '../../core/config';
import type { Aabb, Vector3 } from '../../core/math/vec3';
import { addScaled, set } from '../../core/math/vec3';

/** One in-flight item. Plain data: the render layer reads it, nothing else writes it. */
export interface Throwable {
  /** Unique while alive. Ids are never reused, so a view can key off them. */
  id: number;
  /** True while this slot holds a live object. */
  active: boolean;
  /** Centre of the object. */
  readonly position: Vector3;
  /** Velocity in m/s. */
  readonly velocity: Vector3;
  /** Seconds until detonation. */
  fuseRemaining: number;
  /** Seconds until the object despawns unexploded. */
  lifeRemaining: number;
  /** True once the fuse has been lit; the item is live ordnance from this point. */
  armed: boolean;
}

/** A detonation the world has to resolve. */
export interface Explosion {
  /** Where the blast is centred. A copy, so the pool can recycle the source. */
  readonly position: Vector3;
  readonly radius: number;
  readonly damage: number;
}

/** The item system's public surface. */
export interface ItemSystem {
  /** Every slot, active or not. The render layer reads this and nothing else. */
  readonly throwables: readonly Throwable[];
  /**
   * Throws one item from `position` along the player's aim.
   *
   * Returns false when there is nothing to throw, which is the caller's cue that the
   * charge was not consumed. Direction comes from the player's own yaw/pitch (hard
   * rule 11), never from the render camera.
   */
  throwFrom(position: Vector3, yaw: number, pitch: number): boolean;
  /**
   * Advances every in-flight item by one fixed step.
   *
   * Detonations are appended to `out` rather than resolved here: the blast reads
   * enemy positions and belongs to the world, and keeping that boundary is what lets
   * this module run in a test with no enemies at all.
   */
  tick(dt: number, solids: readonly Aabb[], out: Explosion[]): void;
  /** Retires every in-flight item and returns them to the pool. */
  clear(): void;
  /** Items currently in the air. */
  activeCount(): number;
}

/** Options for {@link createItemSystem}. */
export interface ItemSystemOptions {
  /** Concurrent items. The belt caps at `ITEMS.maxCharges`, so this is generous. */
  readonly poolSize?: number;
  /** Cooldown between throws, in seconds. Overridable for tests. */
  readonly throwCooldown?: number;
}

const DEFAULT_POOL_SIZE = 8;

/** The height the item leaves the hand at, as a fraction of the player's eye height. */
const THROW_ORIGIN_HEIGHT = 0.62;
/**
 * Launch pitch added to the aim, in radians.
 *
 * An underhand arc: the player's crosshair points at the target, and the item is
 * lobbed a little above it so the arc covers the distance. Without this a level shot
 * at 16 m/s lands in about 1.2 s on flat ground, which reads as "it fell out of my
 * hand" rather than as a throw. This is a feel constant, not a rule.
 */
const THROW_LOFT = 0.22;
/** Energy kept by the vertical component on a bounce. Below `bounciness`: a lob dies. */
const BOUNCE_VERTICAL_SCALE = 0.55;
/** Extra speed above which a bounce is not attempted, to avoid jitter on a surface. */
const REST_SPEED = 0.35;

/** Reused, so integrating a step allocates nothing. */
const stepScratch: Vector3 = { x: 0, y: 0, z: 0 };

/**
 * Creates the item system.
 *
 * @param options Pool size and cooldown, both overridable so a test can throw
 *                repeatedly without simulating the cooldown.
 */
export function createItemSystem(options: ItemSystemOptions = {}): ItemSystem {
  const poolSize = Math.max(1, options.poolSize ?? DEFAULT_POOL_SIZE);
  const throwCooldown = options.throwCooldown ?? ITEMS.throwCooldown;
  const floor = SIM.arenaHalfSize;

  const pool: Throwable[] = [];
  for (let i = 0; i < poolSize; i += 1) {
    pool.push({
      id: i + 1,
      active: false,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      fuseRemaining: 0,
      lifeRemaining: 0,
      armed: false,
    });
  }

  let nextId = poolSize + 1;
  let cooldownRemaining = 0;
  let active = 0;

  /**
   * Resolves one axis-aligned surface contact.
   *
   * Returns the axis that was hit, or `null` when the sphere is clear. The normal is
   * the axis of *least penetration*, which is the axis the sphere actually came
   * through — resolving along any other one would push the object through a face it
   * never touched.
   */
  const resolveBox = (item: Throwable, box: Aabb): 'x' | 'y' | 'z' | null => {
    const radius = ITEMS.radius;
    const dx = item.position.x - box.center.x;
    const dy = item.position.y - box.center.y;
    const dz = item.position.z - box.center.z;
    const overlapX = box.halfExtents.x + radius - Math.abs(dx);
    if (overlapX <= 0) return null;
    const overlapY = box.halfExtents.y + radius - Math.abs(dy);
    if (overlapY <= 0) return null;
    const overlapZ = box.halfExtents.z + radius - Math.abs(dz);
    if (overlapZ <= 0) return null;

    if (overlapX <= overlapY && overlapX <= overlapZ) {
      item.position.x += overlapX * (dx < 0 ? -1 : 1);
      return 'x';
    }
    if (overlapY <= overlapZ) {
      item.position.y += overlapY * (dy < 0 ? -1 : 1);
      return 'y';
    }
    item.position.z += overlapZ * (dz < 0 ? -1 : 1);
    return 'z';
  };

  /**
   * Applies a bounce against the axis that was hit.
   *
   * The normal component keeps its direction and is scaled by `bounciness`; the two
   * tangential components are scaled as well, because a grenade that keeps 100% of
   * its sideways speed skitters across the arena like a hockey puck. On the vertical
   * axis the scale is lower still — a thrown object loses more of its arc than of
   * its roll.
   */
  const bounce = (item: Throwable, axis: 'x' | 'y' | 'z'): void => {
    const v = item.velocity;
    const normalScale = axis === 'y' ? ITEMS.bounciness * BOUNCE_VERTICAL_SCALE : ITEMS.bounciness;
    if (axis === 'x') {
      v.x *= -normalScale;
      v.y *= ITEMS.bounciness;
      v.z *= ITEMS.bounciness;
    } else if (axis === 'y') {
      v.y *= -normalScale;
      v.x *= ITEMS.bounciness;
      v.z *= ITEMS.bounciness;
    } else {
      v.z *= -normalScale;
      v.x *= ITEMS.bounciness;
      v.y *= ITEMS.bounciness;
    }
    // Kill the residual jitter: a resting object on a 0.35 restitution would
    // otherwise accumulate sub-centimetre hops forever.
    if (Math.abs(v.y) < REST_SPEED) v.y = 0;
  };

  const detonate = (item: Throwable, out: Explosion[]): void => {
    out.push({
      position: { x: item.position.x, y: item.position.y, z: item.position.z },
      radius: ITEMS.blastRadius,
      damage: ITEMS.blastDamage,
    });
    item.active = false;
    item.armed = false;
    item.fuseRemaining = 0;
    item.lifeRemaining = 0;
    active = Math.max(0, active - 1);
  };

  return {
    throwables: pool,

    throwFrom(position, yaw, pitch) {
      if (cooldownRemaining > 0) return false;
      const slot = pool.find((candidate) => !candidate.active);
      if (!slot) return false;

      // Origin: at the player's hand, along the *flat* forward axis so a steep look
      // does not put the grenade inside the player's own feet.
      const forwardX = -Math.sin(yaw);
      const forwardZ = -Math.cos(yaw);
      set(
        slot.position,
        position.x + forwardX * 0.35,
        position.y + PLAYER.eyeHeight * THROW_ORIGIN_HEIGHT,
        position.z + forwardZ * 0.35,
      );

      // Direction: the player's own aim, lofted. Taken from yaw/pitch rather than
      // from any camera pose (hard rule 11), so the throw goes where the *shot*
      // would go.
      const launchPitch = pitch + THROW_LOFT;
      const cp = Math.cos(launchPitch);
      set(
        slot.velocity,
        -Math.sin(yaw) * cp * ITEMS.throwSpeed,
        Math.sin(launchPitch) * ITEMS.throwSpeed,
        -Math.cos(yaw) * cp * ITEMS.throwSpeed,
      );

      slot.id = nextId++;
      slot.active = true;
      slot.armed = true;
      slot.fuseRemaining = ITEMS.fuse;
      slot.lifeRemaining = ITEMS.maxLifetime;
      active += 1;
      cooldownRemaining = throwCooldown;
      return true;
    },

    tick(dt, solids, out) {
      cooldownRemaining = Math.max(0, cooldownRemaining - dt);
      const radius = ITEMS.radius;

      for (const item of pool) {
        if (!item.active) continue;

        // Semi-implicit Euler, in one step: `x += (v + 0.5 g dt) dt; v += g dt`. The
        // half-step on the position is what makes the arc independent of how the
        // second is subdivided, which a naive `x += v dt; v += g dt` is not.
        stepScratch.x = item.velocity.x * dt;
        stepScratch.y = (item.velocity.y + 0.5 * PLAYER.gravity * dt) * dt;
        stepScratch.z = item.velocity.z * dt;
        addScaled(item.position, item.position, stepScratch, 1);
        item.velocity.y -= PLAYER.gravity * dt;

        // Ground.
        if (item.position.y < radius) {
          item.position.y = radius;
          if (item.velocity.y < 0) bounce(item, 'y');
        }

        // Arena bounds. Treated as walls rather than as an open drop: the fence is
        // solid for the player, so it is solid for a grenade.
        const limit = floor - radius;
        if (item.position.x > limit) {
          item.position.x = limit;
          if (item.velocity.x > 0) bounce(item, 'x');
        } else if (item.position.x < -limit) {
          item.position.x = -limit;
          if (item.velocity.x < 0) bounce(item, 'x');
        }
        if (item.position.z > limit) {
          item.position.z = limit;
          if (item.velocity.z > 0) bounce(item, 'z');
        } else if (item.position.z < -limit) {
          item.position.z = -limit;
          if (item.velocity.z < 0) bounce(item, 'z');
        }

        // Level geometry. `solids` is the bullet-blocking list, which is the same
        // set of boxes the player cannot walk through and excludes the fences — a
        // grenade may therefore leave the arena over the fence only if its arc
        // clears it, which the arena clamp above already prevents.
        for (const box of solids) {
          const axis = resolveBox(item, box);
          if (axis) bounce(item, axis);
        }

        item.fuseRemaining -= dt;
        item.lifeRemaining -= dt;

        // The fuse wins: it detonates wherever it is, including mid-air. That is the
        // whole point of a timed grenade — "it went off in my hand because it hit a
        // crate" would make the arc unpredictable rather than skillful.
        if (item.fuseRemaining <= 0) {
          detonate(item, out);
          continue;
        }
        if (item.lifeRemaining <= 0) {
          // An unexploded lifetime is a dud: it disappears silently. Reaching this
          // means the fuse and the lifetime are misconfigured relative to each other.
          item.active = false;
          item.armed = false;
          item.fuseRemaining = 0;
          item.lifeRemaining = 0;
          active = Math.max(0, active - 1);
        }
      }
    },

    clear() {
      for (const item of pool) {
        item.active = false;
        item.armed = false;
        item.fuseRemaining = 0;
        item.lifeRemaining = 0;
        set(item.position, 0, 0, 0);
        set(item.velocity, 0, 0, 0);
      }
      active = 0;
      cooldownRemaining = 0;
    },

    activeCount() {
      return active;
    },
  };
}
