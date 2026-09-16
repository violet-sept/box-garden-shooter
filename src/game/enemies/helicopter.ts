/**
 * Second-wave AI: the gunship.
 *
 * The gunship is the heavy that **flies**. It shares the Warden's entire attack — the same
 * state machine (`heavyAttacker.ts`), the same straight yellow line solved by
 * `solveWardenAim`, the same wind-up and cooldown numbers and the same 4800 HP, all of which
 * is what the phase-11 brief asks for ("attack method identical to the Warden, health and
 * attack power identical to the Warden") — and differs in exactly one thing: instead of
 * holding a distance band on the ground it flies at {@link HELICOPTER.altitude} and walks a
 * circle around the player at {@link HELICOPTER.orbitRadius}.
 *
 * ## Why a circle rather than "chase and strafe"
 *
 * "It keeps circling the player" is the brief, and a circle is also the honest counterplay to
 * the attack it carries: a shot is dodged by stepping *off the line*, so an attacker that
 * approaches head-on and stops would give the player one axis to run along. An orbiting
 * attacker keeps changing which direction "off the line" is, which is the same problem the
 * Warden's lateral drift poses, one dimension up.
 *
 * ## One speed number, two jobs
 *
 * The tangential speed is `ENEMY_HELICOPTER.moveSpeed`, and when the gunship has drifted
 * outside its radius dead-band the radial correction is folded into the same vector and the
 * whole thing renormalised back to that speed. So "how fast is the gunship going" is one
 * number whether it is circling or closing, rather than a tangential speed plus a separate
 * closing speed that can silently add up to something twice as fast.
 *
 * ## What it deliberately does *not* do
 *
 * It does not move during its wind-up, its shot or its recovery: `tickHeavyAttacker` halts a
 * heavy for those three states, and that is the rule that makes the telegraph readable (the
 * player's return-fire window is a heavy that has stopped). "It keeps circling" therefore
 * means *between* shots. The alternative — a gunship sliding sideways down its own warning
 * line while the player tries to read it — trades the whole readability budget for a verb.
 */

import { HELICOPTER } from '../../core/config';
import { clamp, set } from '../../core/math/vec3';
import type { EnemyState } from './EnemyState';
import type { EnemyContext, EnemyStore } from './EnemyStore';
import { tickHeavyAttacker } from './heavyAttacker';

/**
 * Altitude correction gain, in 1/s.
 *
 * A proportional controller rather than a servo to an exact height: the gunship only ever
 * needs to *get back* to its altitude, and the climb rate caps how hard it tries, so the
 * gain is a feel number (how snappy the correction looks) and nothing else.
 */
const ALTITUDE_GAIN = 2;

/**
 * The gunship's between-shots movement: fly a circle around the player at a fixed altitude.
 *
 * @param distance Flat (ground-plane) distance to the player, handed over by the shared
 *                 machine. The orbit is measured on that plane, not in 3D, or the gunship
 *                 would close in as it climbed and its radius would depend on its height.
 */
function holdOrbit(enemy: EnemyState, ctx: EnemyContext, _store: EnemyStore, distance: number): void {
  const dx = ctx.playerPosition.x - enemy.position.x;
  const dz = ctx.playerPosition.z - enemy.position.z;
  const flat = Math.hypot(dx, dz);
  // Radial unit vector (toward the player) and the tangent, which is that vector rotated a
  // quarter turn. The handedness is fixed rather than random so a run is reproducible.
  const rx = flat > 1e-6 ? dx / flat : 0;
  const rz = flat > 1e-6 ? dz / flat : 0;
  const tx = -rz;
  const tz = rx;

  // Only correct the radius once it has drifted outside the dead band. Chasing an exact
  // radius every tick makes the gunship jitter whenever the player walks, because the
  // player's own motion is what the radius is measured from.
  let radial = 0;
  if (distance > HELICOPTER.orbitRadius + HELICOPTER.orbitTolerance) radial = 1;
  else if (distance < HELICOPTER.orbitRadius - HELICOPTER.orbitTolerance) radial = -1;

  let vx = tx + rx * radial;
  let vz = tz + rz * radial;
  const length = Math.hypot(vx, vz);
  const scale = length > 1e-6 ? enemy.stats.moveSpeed / length : 0;
  vx *= scale;
  vz *= scale;

  const climb = clamp((HELICOPTER.altitude - enemy.position.y) * ALTITUDE_GAIN, -HELICOPTER.climbRate, HELICOPTER.climbRate);

  set(enemy.velocity, vx, climb, vz);
}

/** Advances one gunship by one tick. Identity, attack and enrage all come from the shared machine. */
export function tickHelicopter(enemy: EnemyState, ctx: EnemyContext, store: EnemyStore): void {
  tickHeavyAttacker(enemy, ctx, store, holdOrbit);
}
