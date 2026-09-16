/**
 * The attack state machine the two heavy enemies share (phase 11).
 *
 * ```
 * SPAWN → IDLE → REPOSITION → TELEGRAPH → SHOT → RECOVER → (ENRAGE) → DEAD
 * ```
 *
 * Everything here is about the **attack**: when the wind-up starts, how the warning line is
 * kept in step with the player, when the bolt's direction is frozen, and how enrage
 * compresses the cooldown without ever touching the telegraph. What a heavy does *between*
 * shots is the only thing that differs between the Warden and the gunship, so that one part
 * is injected — `hold` is the archetype's "keep moving while you wait" behaviour.
 *
 * ## Why this is a shared machine rather than two similar ones
 *
 * The phase-11 brief asks for the gunship's attack to be "the same as the Warden's". The only
 * way "the same" survives the next retune is for there to be **one implementation**: with a
 * second copy of this switch, changing the Warden's wind-up would leave the two heavies
 * telegraphing for different lengths of time while both were documented as identical, and no
 * test would fail. This file was extracted from `largeWarden.ts` verbatim for that reason —
 * the Warden's behaviour is bit-identical to what it was, and the gunship's is that code with
 * a different `hold`.
 *
 * ## Three rules that live here and must not be relaxed
 *
 *   1. **The telegraph is never shortened.** `frames.ts` takes an explicit scale and this
 *      file only ever passes it to the cooldown and the recovery. Enrage makes a heavy
 *      *busier*, never less fair.
 *   2. **The line is re-solved every tick of the wind-up and frozen when the shot leaves.**
 *      {@link solveWardenAim} writes `enemy.aim`, the presentation layer draws exactly that,
 *      and `fireShot` copies it into a projectile that nothing re-aims afterwards.
 *   3. **A heavy is rooted while it winds up and fires.** `halt` on TELEGRAPH / SHOT /
 *      RECOVER is the player's return-fire window, and a heavy that walked during its own
 *      telegraph would make the telegraph a lie. This is also why the gunship stops
 *      orbiting while it winds up (see `helicopter.ts`) even though the brief says it
 *      "keeps circling": it keeps circling *between* shots, which is the same discipline the
 *      Warden's band-hold has.
 *
 * ## Why the shot geometry lives in this file too
 *
 * `solveWardenAim` was extracted from `largeWarden.ts` along with the state machine, and the
 * name stayed: the *shot* is the Warden's (its five numbers are the `WARDEN` block in
 * `core/config.ts`) and the gunship fires that same shot rather than one of its own. Keeping
 * the solver next to the only caller that re-solves it every tick is what stops the gunship
 * from growing a second, subtly different line — and the muzzle offset it derives from
 * `enemy.stats.radius` means the 1.6 m gunship already leaves its own airframe's surface
 * without a second constant.
 */

import { ENEMY, ENRAGE_COOLDOWN_SCALE, PLAYER, WARDEN } from '../../core/config';
import { type Vector3, distanceXZ, set } from '../../core/math/vec3';
import { phaseAt, telegraphProgress } from './frames';
import { attackFrameFor, type EnemyState, type WardenAim } from './EnemyState';
import type { EnemyContext, EnemyStore } from './EnemyStore';

/** Seconds the enrage "announcement" lasts before normal behaviour resumes. */
const ENRAGE_ANNOUNCE_TIME = 1.1;

/**
 * Solves the straight line from a heavy's muzzle to the player's chest, **in place**.
 *
 * This is the one place the shot's geometry is decided, for both heavies. The AI calls it
 * every tick of the wind-up (so the warning line tracks) and the store copies what it
 * produced at the instant of firing. Two properties matter:
 *
 *   - **The direction is measured from the muzzle, not from the body's centre.** The origin
 *     is pushed out to the body's surface along the aim, and the direction is then solved
 *     again from *that* point; skipping the second solve leaves the line pointing at the
 *     player from a metre to one side, which at 20 m is a visible miss of about a metre.
 *   - **The muzzle offset is derived, not a second constant.** `enemy.stats.radius` is
 *     already the body's width for collision, so "leave from the surface" needs no new
 *     number and a differently sized heavy gets a proportionate muzzle for free — which is
 *     exactly what the gunship's 1.6 m airframe relies on.
 *
 * Exported so the geometry can be asserted directly, and so neither archetype has a second
 * copy of it.
 */
export function solveWardenAim(out: WardenAim, enemy: EnemyState, target: Vector3): WardenAim {
  const muzzleY = enemy.position.y + WARDEN.shotOriginHeight;
  // The player's chest rather than their feet: a line solved toward the ground plane grazes
  // the hurtbox's bottom edge and reads as passing *under* the player.
  const targetY = target.y + PLAYER.height * 0.5;

  let dx = target.x - enemy.position.x;
  let dy = targetY - muzzleY;
  let dz = target.z - enemy.position.z;
  const distance = Math.hypot(dx, dy, dz);
  if (distance < 1e-6) {
    // Degenerate (the player is standing inside the heavy). Fall back to a level shot rather
    // than producing a NaN direction that would poison every later tick.
    dx = 0;
    dy = 0;
    dz = -1;
  } else {
    dx /= distance;
    dy /= distance;
    dz /= distance;
  }

  const push = enemy.stats.radius;
  out.origin.x = enemy.position.x + dx * push;
  out.origin.y = muzzleY + dy * push;
  out.origin.z = enemy.position.z + dz * push;

  // Second solve, from the real origin. This is what makes the line the crosshair of the
  // attack: it points at the player's chest from where the bolt actually starts.
  const toX = target.x - out.origin.x;
  const toY = targetY - out.origin.y;
  const toZ = target.z - out.origin.z;
  const reach = Math.hypot(toX, toY, toZ);
  if (reach < 1e-6) {
    out.direction.x = dx;
    out.direction.y = dy;
    out.direction.z = dz;
    out.length = 0;
  } else {
    out.direction.x = toX / reach;
    out.direction.y = toY / reach;
    out.direction.z = toZ / reach;
    out.length = reach;
  }
  return out;
}

/**
 * Body yaw for a look direction. Matches `forwardFromYawPitch`'s convention.
 *
 * Exported because every hold behaviour needs it: a heavy always faces the player rather
 * than its own direction of travel, which is what makes its wind-up readable.
 */
export function yawTowards(from: Vector3, to: Vector3): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

/** Stops the enemy outright, velocity included. */
export function halt(enemy: EnemyState): void {
  set(enemy.velocity, 0, 0, 0);
}

/**
 * The archetype's between-shots movement.
 *
 * Called only from `REPOSITION`, once the "should I attack instead?" question has been
 * answered, and it owns the body's velocity and facing for that tick. It is handed the flat
 * distance to the player because both implementations need it and recomputing it inside
 * each one would be a second definition of "how far away is the player".
 */
export type HeavyHold = (enemy: EnemyState, ctx: EnemyContext, store: EnemyStore, distance: number) => void;

/**
 * Advances one heavy enemy by one tick.
 *
 * @param hold The archetype's band/orbit behaviour, run while it is holding station.
 */
export function tickHeavyAttacker(
  enemy: EnemyState,
  ctx: EnemyContext,
  store: EnemyStore,
  hold: HeavyHold,
): void {
  const frame = attackFrameFor(enemy.stats);
  const distance = distanceXZ(enemy.position, ctx.playerPosition);
  // The enrage scale is the archetype's own numeric modifier, read here and handed to the
  // frame machine. It never touches `telegraphTime`.
  const cooldownScale = enemy.enraged ? ENRAGE_COOLDOWN_SCALE : 1;
  // Read from the archetype rather than written as a literal: "how far away can it notice
  // me" is a stat, and both heavies happen to share the value 60 today.
  const engageDistance = enemy.stats.detectionRange;

  switch (enemy.fsm) {
    case 'SPAWN': {
      halt(enemy);
      enemy.view.yaw = yawTowards(enemy.position, ctx.playerPosition);
      if (enemy.stateTime >= ENEMY.turnDelay) {
        enemy.fsm = distance <= engageDistance ? 'REPOSITION' : 'IDLE';
        enemy.stateTime = 0;
      }
      break;
    }

    case 'IDLE': {
      halt(enemy);
      enemy.view.yaw = yawTowards(enemy.position, ctx.playerPosition);
      if (distance <= engageDistance) {
        enemy.fsm = 'REPOSITION';
        enemy.stateTime = 0;
      }
      break;
    }

    case 'ENRAGE': {
      // One readable beat. The heavy plants, glows, and then resumes — it does not gain a
      // new move. Keeping enrage as a *number* rather than a second state machine is what
      // stops a rebalance having to be applied twice.
      halt(enemy);
      enemy.view.lunging = true;
      enemy.view.telegraphGlow = 1;
      enemy.view.yaw = yawTowards(enemy.position, ctx.playerPosition);
      if (enemy.stateTime >= ENRAGE_ANNOUNCE_TIME) {
        enemy.view.lunging = false;
        enemy.fsm = 'REPOSITION';
        enemy.stateTime = 0;
      }
      break;
    }

    case 'REPOSITION': {
      enemy.view.yaw = yawTowards(enemy.position, ctx.playerPosition);
      enemy.view.telegraphGlow = 0;
      enemy.view.lunging = false;

      if (ctx.playerAlive && distance <= enemy.stats.attackRange && enemy.attackCooldown <= 0) {
        enemy.fsm = 'TELEGRAPH';
        enemy.stateTime = 0;
        enemy.attackElapsed = 0;
        enemy.attackResolved = false;
        enemy.shots.length = 0;
        // One emission, at the start of the wind-up. There is nothing to "lock" later: the
        // line is redrawn every tick of the wind-up and frozen when the bolt leaves, which is
        // a different fact with its own event (`enemy:shot`).
        solveWardenAim(enemy.aim, enemy, ctx.playerPosition);
        enemy.aim.active = true;
        ctx.attacks.telegraph(enemy, 'shot', ctx.time + frame.telegraphTime);
        break;
      }

      hold(enemy, ctx, store, distance);
      break;
    }

    case 'TELEGRAPH': {
      halt(enemy);
      enemy.view.lunging = true;
      enemy.view.telegraphGlow = telegraphProgress(enemy.attackElapsed, frame);
      enemy.view.yaw = yawTowards(enemy.position, ctx.playerPosition);
      // The line is re-solved every tick of the wind-up, so it tracks the player right up to
      // the instant the shot leaves. The very same call produces the values `fireShot` copies
      // below, which is why the drawn line and the bolt agree.
      solveWardenAim(enemy.aim, enemy, ctx.playerPosition);
      enemy.attackElapsed += ctx.dt;

      // Fire on the tick the wind-up ends. The shot is a straight line from here on and
      // `fireShot` freezes it: nothing in the store ever writes the direction again.
      if (!enemy.attackResolved && phaseAt(enemy.attackElapsed, frame, cooldownScale) !== 'TELEGRAPH') {
        enemy.attackResolved = true;
        enemy.aim.active = false;
        ctx.attacks.fireShot(enemy);
      }
      if (phaseAt(enemy.attackElapsed, frame, cooldownScale) !== 'TELEGRAPH') {
        enemy.fsm = 'SHOT';
        enemy.stateTime = 0;
      }
      break;
    }

    case 'SHOT': {
      // Rooted for the whole active window: a heavy committing to its own shot is the
      // player's return-fire window, and moving would make the telegraph a lie.
      //
      // The window is *not* extended until the bolt lands. That was the right rule for area
      // blasts falling on the ground around it, and the wrong one for a projectile travelling
      // away from it: the bolt is already a fact in the world, and standing still for three
      // more seconds would cost the player the fight's rhythm for no readability gain. The
      // bolt keeps flying while its owner recovers; `resolveShots` runs for every live heavy
      // regardless of this state.
      halt(enemy);
      enemy.view.lunging = true;
      enemy.view.telegraphGlow = 1;
      enemy.view.yaw = yawTowards(enemy.position, ctx.playerPosition);
      enemy.attackElapsed += ctx.dt;
      if (phaseAt(enemy.attackElapsed, frame, cooldownScale) !== 'ACTIVE') {
        enemy.fsm = 'RECOVER';
        enemy.stateTime = 0;
        enemy.view.lunging = false;
      }
      break;
    }

    case 'RECOVER': {
      halt(enemy);
      enemy.view.telegraphGlow = 0;
      enemy.view.lunging = false;
      enemy.attackElapsed += ctx.dt;
      if (phaseAt(enemy.attackElapsed, frame, cooldownScale) === 'DONE') {
        enemy.attackElapsed = 0;
        // Enrage compresses the *cooldown*, which is the other half of "faster but not less
        // fair": the player gets less time between volleys, never less warning before one.
        enemy.attackCooldown = enemy.stats.attackCooldown * cooldownScale;
        enemy.fsm = 'REPOSITION';
        enemy.stateTime = 0;
      }
      break;
    }

    case 'STAGGER': {
      // The store owns the exit via `stunRemaining`. Velocity is left alone so the weak-point
      // stagger still reads as an impact.
      enemy.view.telegraphGlow = 0;
      enemy.view.lunging = false;
      break;
    }

    default: {
      halt(enemy);
      break;
    }
  }
}
