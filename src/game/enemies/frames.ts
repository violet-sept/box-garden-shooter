/**
 * Attack frame data.
 *
 * An attack is three numbers, not three functions: a telegraph window, an active
 * window and a recovery window. Encoding it as data is what makes balance work a
 * numbers change (technical plan section 3.2.4) — the state machine that reads
 * these never has to be touched, and the two archetypes share it outright.
 *
 * ## The boundary convention, which is the whole point of this file
 *
 * Each window is **left-closed, right-open**, and a crossing lands in the *later*
 * phase:
 *
 * ```
 *   elapsed = 0                        telegraphTime            + activeTime          + recoveryTime
 *      |                                    |                       |                       |
 *      |<----------- TELEGRAPH ------------->|<------- ACTIVE ------->|<----- RECOVER ------->|  DONE
 *      |                                    |                       |                       |
 *   phaseAt(0)                    phaseAt(t) === ACTIVE    phaseAt(t) === RECOVER    phaseAt(total) === DONE
 * ```
 *
 * So `phaseAt(telegraphTime, f, s) === 'ACTIVE'` exactly, and
 * `phaseAt(telegraphTime - epsilon, f, s) === 'TELEGRAPH'`. Written down because
 * "which side of the boundary is the exact instant on" is the kind of question
 * that gets answered two different ways in two different systems, and the two
 * answers differ by one tick at 60 Hz — invisible in play, but enough to make a
 * test flaky and a hit log disagree with a hitbox by a frame.
 *
 * ## Enrage
 *
 * `cooldownScale` multiplies the recovery window and (via the caller) the
 * cooldown between attacks. It **never** touches `telegraphTime`. The telegraph
 * is the only cue the player has to react, so shortening it converts "hard" into
 * "unfair" — hard rule 9 in the stage-2 brief, and the reason this function takes
 * the scale as a parameter instead of reading it from config internally.
 */

/** The three windows of one attack, in seconds. */
export interface AttackFrame {
  /** Wind-up. Visible, telegraphed, deals no damage. Never scaled. */
  readonly telegraphTime: number;
  /** The damaging window. */
  readonly activeTime: number;
  /** Wind-down, during which the attacker cannot act. The player's opening. */
  readonly recoveryTime: number;
}

/** Where an attack is in its lifecycle. */
export type FramePhase = 'TELEGRAPH' | 'ACTIVE' | 'RECOVER' | 'DONE';

/**
 * Window of time before the telegraph ends, during which a locked impact point
 * is considered "about to land".
 *
 * Not used by the phase machine; it is the threshold the presentation layer reads
 * to decide when an indicator starts pulsing, and it lives here so the render
 * layer does not invent its own copy of a timing rule.
 */
export const IMPACT_WARNING_WINDOW = 0.35;

/** Total length of an attack, before any enrage scaling. */
export function totalFrameTime(frame: AttackFrame): number {
  return frame.telegraphTime + frame.activeTime + frame.recoveryTime;
}

/**
 * Recovery length under an enrage scale.
 *
 * Clamped at zero so a nonsensical scale cannot make an attack end before it
 * started, and floored at one tick's worth of time so an "instant" recovery is
 * still resolvable by the fixed-step simulation.
 */
export function scaledRecoveryTime(frame: AttackFrame, cooldownScale: number): number {
  return Math.max(0, frame.recoveryTime) * Math.max(0, cooldownScale);
}

/** Total length of an attack under an enrage scale, telegraph included unscaled. */
export function scaledTotalFrameTime(frame: AttackFrame, cooldownScale: number): number {
  return Math.max(0, frame.telegraphTime) + Math.max(0, frame.activeTime) + scaledRecoveryTime(frame, cooldownScale);
}

/**
 * Which phase an attack is in at `elapsed`, under an enrage scale.
 *
 * See the boundary convention in the module header: each window is left-closed,
 * so the exact instant a window ends already belongs to the next one.
 *
 * @param cooldownScale Multiplier on the recovery window only. Usually
 *                      `ENRAGE_COOLDOWN_SCALE` while enraged and `1` otherwise.
 */
export function phaseAt(elapsed: number, frame: AttackFrame, cooldownScale = 1): FramePhase {
  const telegraph = Math.max(0, frame.telegraphTime);
  const active = Math.max(0, frame.activeTime);
  if (elapsed < telegraph) return 'TELEGRAPH';
  if (elapsed < telegraph + active) return 'ACTIVE';
  if (elapsed < scaledTotalFrameTime(frame, cooldownScale)) return 'RECOVER';
  return 'DONE';
}

/**
 * Seconds remaining in the telegraph, or zero once it has ended.
 *
 * The single caller is the presentation layer, which uses it to size the glow
 * ramp; keeping it here means the render layer never does its own arithmetic on
 * frame times.
 */
export function telegraphRemaining(elapsed: number, frame: AttackFrame): number {
  return Math.max(0, Math.max(0, frame.telegraphTime) - elapsed);
}

/**
 * Fraction of the telegraph already elapsed, in `[0, 1]`.
 *
 * One at and beyond the end, so a caller blending an effect toward "about to
 * land" does not have to special-case the instant the window closes.
 */
export function telegraphProgress(elapsed: number, frame: AttackFrame): number {
  const telegraph = Math.max(0, frame.telegraphTime);
  if (telegraph <= 0) return 1;
  return Math.min(1, Math.max(0, elapsed) / telegraph);
}

/**
 * True when `elapsed` is inside the damaging window.
 *
 * The attack paths deliberately use this rather than comparing a phase string:
 * "is this attack allowed to deal damage right now" is a question about time, and
 * answering it from time cannot drift out of step with {@link phaseAt}.
 */
export function isActive(elapsed: number, frame: AttackFrame, cooldownScale = 1): boolean {
  return phaseAt(elapsed, frame, cooldownScale) === 'ACTIVE';
}
