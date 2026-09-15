/**
 * The player body's own yaw — the turn the character does to catch up.
 *
 * ## Why the body has a yaw of its own
 *
 * The simulation's `player.yaw` is the **camera's** yaw, and the brief's view convention
 * makes the camera the authority for everything that matters: movement is solved relative
 * to where the camera looks, and the shot goes where the crosshair is. None of that
 * changes here. What this module owns is purely what the *body* does about it, and the
 * two are not the same question:
 *
 *   - walking north while looking east is possible, and then the body should face north;
 *   - standing still and looking around should turn the character on the spot;
 *   - and in both cases the turn should take a moment, because an instant snap reads as a
 *     teleport rather than as a character.
 *
 * Before this module the body was pinned to `player.yaw` and written in one line, so the
 * character was a turret welded to the crosshair: it never turned, and — on the procedural
 * stand-in, which is what actually ships until the art arrives — it also had no front to
 * turn. That is the whole of "增加转身的动作".
 *
 * ## What it is not
 *
 * No gameplay value is read or written: the body's yaw never feeds the shot, the movement
 * solver, the camera or the enemy AI, and the debug panel reports the *player's* angles.
 * The turn therefore cannot make the game unfair — it is a lag on a picture, not on a
 * bullet. It lives in `render/` with the rest of the presentation for that reason, and
 * because of it the layer rule holds: no game rule is decided here.
 *
 * ## Frame-rate independence
 *
 * The pivot is **rate-limited, not damped**: `turnRateDegPerSec` is a hard angular speed,
 * so the character turns at the same speed on a 60 Hz display and a 240 Hz one, and a
 * given turn takes the same wall-clock time. The lean *is* damped (exponential), because
 * a rate-limited quantity snapping to zero at the end of a turn pops visibly.
 */

import { PLAYER } from '../../core/config';
import { DEG2RAD, clamp, wrapAngle } from '../../core/math/vec3';

/**
 * The body's pose, as the renderer needs it.
 *
 * Mutable and written in place, like the camera state: this is advanced once per rendered
 * frame and never crosses a layer boundary.
 */
export interface BodyPose {
  /** Yaw the body currently faces, radians, in the simulation's convention (0 is −Z). */
  yaw: number;
  /** Roll applied while pivoting, radians. Negative leans into a left-hand turn. */
  bank: number;
  /** Angle still to turn **after** this step, radians. Surfaced for tests and tuning. */
  error: number;
}

/** Maximum lean, in radians, from `PLAYER.bodyTurnBankMaxDeg`. */
const MAX_BANK_RAD = PLAYER.bodyTurnBankMaxDeg * DEG2RAD;

/** Creates a pose already facing `yaw`, with no lean. */
export function createBodyPose(yaw = 0): BodyPose {
  return { yaw: wrapAngle(yaw), bank: 0, error: 0 };
}

/** Snaps a pose to a new facing. Used on spawn and on restart, never mid-run. */
export function resetBodyPose(pose: BodyPose, yaw: number): BodyPose {
  pose.yaw = wrapAngle(yaw);
  pose.bank = 0;
  pose.error = 0;
  return pose;
}

/**
 * Which way the body should point.
 *
 * Moving: the direction of travel. Standing: the camera's yaw, so looking around pivots the
 * character on the spot. The velocity is the **simulation's own**, not the input intent —
 * a player pressed against a crate is holding `W` and going nowhere, and a body that turns
 * to face the crate it is leaning on is the visible tell that the renderer was asked about
 * the keyboard instead of about the world.
 *
 * `yaw = atan2(-vx, -vz)` because this project's yaw zero faces −Z: at `yaw = 0` the forward
 * vector is `(0, 0, -1)`, which is the same convention `forwardFromYawPitch` and the
 * movement solver use.
 */
export function targetBodyYaw(
  velocityX: number,
  velocityZ: number,
  cameraYaw: number,
  speedThreshold: number = PLAYER.idleSpeedThreshold,
): number {
  const speed = Math.hypot(velocityX, velocityZ);
  if (speed < speedThreshold) return cameraYaw;
  return Math.atan2(-velocityX, -velocityZ);
}

/**
 * Shortest signed way round from one yaw to another, in `(-π, π]`.
 *
 * Exported because "the character spun the long way round" is a bug that looks like a
 * wrong rate until you check this: a raw `to - from` is off by 2π across the wrap and a
 * rate-limited turn then takes the scenic route.
 */
export function shortestAngleTo(from: number, to: number): number {
  return wrapAngle(to - from);
}

/**
 * Advances the pivot by one rendered frame.
 *
 * @param dt Render time in seconds. The turn is presentation, so it runs on the render
 *           clock and is deliberately *not* scaled by hitstop: a frozen enemy should not
 *           freeze the character's animation.
 */
export function stepBodyPose(pose: BodyPose, targetYaw: number, dt: number): BodyPose {
  const delta = shortestAngleTo(pose.yaw, targetYaw);
  const maxStep = PLAYER.turnRateDegPerSec * DEG2RAD * Math.max(0, dt);
  // `clamp` is the whole rate limit; when it does not bite, the pose lands exactly on the
  // target instead of approaching it asymptotically. That is what makes "a 180° turn takes
  // 0.25 s at 720°/s" an assertion rather than an approximation.
  const step = clamp(delta, -maxStep, maxStep);

  pose.yaw = wrapAngle(pose.yaw + step);
  pose.error = wrapAngle(delta - step);

  // The lean follows the angle still to go, not the angular velocity: no division by `dt`
  // (which is unbounded on a hitched frame) and no noise amplification from a jittery
  // difference. Positive `pose.error` is a left-hand turn, and a body leaning into it tips
  // to its own left, which is a negative roll about the model's local Z.
  const wanted = clamp(-pose.error * PLAYER.bodyTurnBankGain, -MAX_BANK_RAD, MAX_BANK_RAD);
  const factor = 1 - Math.exp(-PLAYER.bodyTurnBankRate * Math.max(0, dt));
  pose.bank += (wanted - pose.bank) * factor;

  return pose;
}
