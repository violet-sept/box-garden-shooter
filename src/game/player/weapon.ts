/**
 * Weapon state machine.
 *
 * Owns fire cadence, the magazine, spread growth and the recoil accumulator.
 * It is deliberately a pure data machine: `tick()` takes an intent and a `dt` and
 * returns what happened. No meshes, no camera, no timers — which is what lets
 * `tests/weapon.test.ts` assert the two headline claims directly:
 *
 *   - Fire rate is decided by RPM and is *identical* at 30, 60 and 144 FPS.
 *   - An empty-magazine reload really is faster than a tactical one.
 *
 * Two rules from the technical plan are enforced here and must not be relaxed:
 *
 *   **The cadence accumulator is additive.** `fireCooldown += 60 / rpm` rather
 *   than `= 60 / rpm`. Assigning would let the fractional remainder of each
 *   frame's `dt` be discarded over and over, and the measured RPM would drift
 *   below the configured value — measurably so at 144 Hz.
 *
 *   **Cooldown is never allowed to go more negative than one interval.** If it
 *   were, a player who held the trigger through a long reload would be handed a
 *   burst of queued-up shots the instant the magazine seated.
 */

import { PLAYER, WEAPON } from '../../core/config';
import { type Rng, createRng } from '../../core/math/rng';
import { clamp } from '../../core/math/vec3';

/** Coarse weapon state. ADS is tracked separately because it is orthogonal. */
export type WeaponMode = 'idle' | 'firing' | 'reloading';

/** Per-tick input the weapon reacts to. */
export interface WeaponIntent {
  /** Level-triggered: true while the fire button is held. */
  readonly fire: boolean;
  /** Level-triggered: true while the aim button is held. */
  readonly aim: boolean;
  /** Edge-triggered: true on the tick R was pressed. */
  readonly reloadPressed: boolean;
}

/** Mutable weapon state. One instance per player. */
export interface WeaponState {
  mode: WeaponMode;
  /** Rounds in the magazine. */
  magazine: number;
  /** Rounds in reserve. */
  reserve: number;
  /** Seconds until the next round may leave the barrel. */
  fireCooldown: number;
  /** Seconds elapsed in the current reload. */
  reloadElapsed: number;
  /**
   * Simulation time the current reload began.
   *
   * Distinct from `reloadElapsed` because it answers "did this reload start on
   * this very tick?", which is what stops an edge-triggered R from both starting
   * and cancelling a reload inside one step.
   */
  reloadStartTime: number;
  /** Duration of the current reload; resolves the empty-vs-tactical question. */
  reloadDuration: number;
  /** True when the current reload started from an empty magazine. */
  reloadFromEmpty: boolean;
  /** Whether the current reload is still inside its cancellable window. */
  reloadCancellable: boolean;

  /** Current spread cone half-angle in degrees. */
  spreadDeg: number;
  /** Whether the trigger was held last tick, used to drop the cooldown cleanly. */
  triggerHeld: boolean;

  /** Aim-down-sights blend in [0, 1]. */
  adsProgress: number;
  /** True once `adsProgress` has reached 1. */
  aiming: boolean;

  /** Accumulated recoil still to be applied by the camera, in degrees. */
  recoilPitchDeg: number;
  recoilYawDeg: number;

  /** Deterministic source for the horizontal recoil wobble. */
  rng: Rng;

  /** Simulation time the last round was fired, for FX latency logging. */
  lastShotTime: number;
  /** Rounds fired since the last reload; the debug panel shows it. */
  shotsSinceReload: number;
}

/** What happened during one `tick`. The caller turns these into world effects. */
export interface WeaponTickResult {
  /** True when a round should leave the barrel this tick. */
  readonly fired: boolean;
  /** Spread cone to use for the shot, in degrees, sampled at fire time. */
  readonly spreadDeg: number;
  /** Recoil impulse to add to the camera, in degrees. */
  readonly recoilPitchDeg: number;
  readonly recoilYawDeg: number;
  readonly reloadStarted: boolean;
  readonly reloadFinished: boolean;
  readonly reloadCancelled: boolean;
  /** True on the tick the magazine first runs dry. */
  readonly magazineEmptied: boolean;
  /** True when a fire request was refused because the magazine was empty. */
  readonly dryFire: boolean;
}

/** Creates a fresh weapon state. */
export function createWeaponState(seed = 0x5eed): WeaponState {
  return {
    mode: 'idle',
    magazine: WEAPON.magazineSize,
    reserve: WEAPON.reserveAmmo,
    fireCooldown: 0,
    reloadElapsed: 0,
    reloadStartTime: -Infinity,
    reloadDuration: WEAPON.reloadTime,
    reloadFromEmpty: false,
    reloadCancellable: false,
    spreadDeg: WEAPON.spreadHipDeg,
    triggerHeld: false,
    adsProgress: 0,
    aiming: false,
    recoilPitchDeg: 0,
    recoilYawDeg: 0,
    rng: createRng(seed),
    lastShotTime: 0,
    shotsSinceReload: 0,
  };
}

/** Restores a weapon to its starting condition without reallocating. */
export function resetWeaponState(state: WeaponState): void {
  state.mode = 'idle';
  state.magazine = WEAPON.magazineSize;
  state.reserve = WEAPON.reserveAmmo;
  state.fireCooldown = 0;
  state.reloadElapsed = 0;
  state.reloadStartTime = -Infinity;
  state.reloadDuration = WEAPON.reloadTime;
  state.reloadFromEmpty = false;
  state.reloadCancellable = false;
  state.spreadDeg = WEAPON.spreadHipDeg;
  state.triggerHeld = false;
  state.adsProgress = 0;
  state.aiming = false;
  state.recoilPitchDeg = 0;
  state.recoilYawDeg = 0;
  state.shotsSinceReload = 0;
}

/** Seconds between rounds at the configured cyclic rate. */
export function fireInterval(): number {
  return 60 / WEAPON.rpm;
}

/** The spread the weapon would use right now, given its current ADS blend. */
export function effectiveSpread(state: WeaponState): number {
  const t = state.adsProgress;
  return WEAPON.spreadHipDeg + (WEAPON.spreadAdsDeg - WEAPON.spreadHipDeg) * t;
}

/** Movement speed multiplier from the current ADS blend. */
export function adsMoveScale(state: WeaponState): number {
  return 1 + (PLAYER.adsMoveScale - 1) * state.adsProgress;
}

/** Look sensitivity multiplier from the current ADS blend. */
export function adsLookScale(state: WeaponState): number {
  return 1 + (PLAYER.adsSensitivityScale - 1) * state.adsProgress;
}

/** Reload duration for a magazine that is (or is not) completely empty. */
export function reloadDurationFor(empty: boolean): number {
  return empty ? WEAPON.reloadTimeEmpty : WEAPON.reloadTime;
}

/**
 * Advances the weapon by one fixed tick.
 *
 * Ordering inside the tick is load-bearing:
 *   1. ADS blend, so the spread sampled by a shot already reflects the current
 *      aim state rather than lagging a frame.
 *   2. Spread recovery, so a shot never fires with spread that is still inflated
 *      from a previous burst by more than one tick.
 *   3. Reload progression, which may *end* a reload on this tick.
 *   4. Fire decision, last, so a round fired on the same tick a reload completes
 *      is allowed (that is the "reload cancel into a shot" feel).
 */
export function tickWeapon(state: WeaponState, intent: WeaponIntent, dt: number, time: number): WeaponTickResult {
  let fired = false;
  let shotSpread = state.spreadDeg;
  let recoilPitchDeg = 0;
  let recoilYawDeg = 0;
  let reloadStarted = false;
  let reloadFinished = false;
  let reloadCancelled = false;
  let magazineEmptied = false;
  let dryFire = false;

  // --- 1. ADS blend ---------------------------------------------------------
  const adsTarget = intent.aim ? 1 : 0;
  const adsStep = PLAYER.adsTime > 0 ? dt / PLAYER.adsTime : 1;
  if (state.adsProgress < adsTarget) {
    state.adsProgress = Math.min(adsTarget, state.adsProgress + adsStep);
  } else if (state.adsProgress > adsTarget) {
    state.adsProgress = Math.max(adsTarget, state.adsProgress - adsStep);
  }
  state.aiming = state.adsProgress >= 1;

  // --- 2. Spread recovery ---------------------------------------------------
  // Recovery is linear in seconds (a rate), not exponential: bloom that decays
  // at a constant rate is what players can actually learn and counter. It is
  // faster while aiming so the cone settles within the ADS transition rather than
  // lagging visibly behind the sight picture.
  const baseSpread = effectiveSpread(state);
  const recoveryRate = WEAPON.spreadRecoveryPerSec * (1 + (WEAPON.spreadRecoveryAdsScale - 1) * state.adsProgress);
  state.spreadDeg = Math.max(baseSpread, state.spreadDeg - recoveryRate * dt);

  // --- 3. Reload progression ------------------------------------------------
  // Cancel is checked *before* completion, so a player who double-taps R inside
  // the opening window gets the cancel rather than having the reload finish out
  // from under them. The `reloadStartTime` guard stops the tick that *started* the
  // reload from also ending it: an edge-triggered R is true for the whole tick it
  // arrived on, so without that guard a single press would start and cancel in the
  // same step and the reload could never begin.
  if (state.mode === 'reloading') {
    // Cancellability is sampled *before* this tick's time is added, so the window
    // is measured from the reload's start rather than from the next tick. Reading
    // it afterwards would make the effective window one tick short of the
    // configured value — invisible in play, but exactly the kind of drift that
    // makes a 0.35 s window unlearnable.
    const cancellable = state.reloadElapsed <= WEAPON.reloadCancelWindow;
    state.reloadElapsed += dt;
    if (intent.reloadPressed && cancellable && time > state.reloadStartTime) {
      state.mode = 'idle';
      state.reloadElapsed = 0;
      state.reloadCancellable = false;
      reloadCancelled = true;
    } else if (state.reloadElapsed >= state.reloadDuration) {
      const needed = WEAPON.magazineSize - state.magazine;
      const taken = Math.min(needed, state.reserve);
      state.magazine += taken;
      state.reserve -= taken;
      state.mode = 'idle';
      state.reloadElapsed = 0;
      state.reloadCancellable = false;
      state.reloadFromEmpty = false;
      state.shotsSinceReload = 0;
      reloadFinished = true;
    } else {
      state.reloadCancellable = cancellable;
    }
  }

  const canStartReload =
    state.mode !== 'reloading' && state.magazine < WEAPON.magazineSize && state.reserve > 0;

  // A manual reload may start on any tick the magazine is short. Checked before
  // the fire decision so that pressing R while holding the trigger prioritises
  // the reload rather than being swallowed by a shot.
  //
  // A cancellation earlier in this same tick must suppress it: R is a single
  // edge flag, so without this a double-tap would cancel and immediately restart
  // the reload, and the visible state would never leave RELOADING.
  if (intent.reloadPressed && canStartReload && !reloadCancelled) {
    state.mode = 'reloading';
    state.reloadElapsed = 0;
    state.reloadStartTime = time;
    state.reloadFromEmpty = state.magazine === 0;
    state.reloadDuration = reloadDurationFor(state.magazine === 0);
    state.reloadCancellable = true;
    reloadStarted = true;
  }

  // --- 4. Fire decision -----------------------------------------------------
  // Cooldown always advances, even while reloading, so the accumulator stays
  // honest across a magazine change.
  state.fireCooldown -= dt;

  // Automatic weapons fire while held; everything else needs a fresh press, which
  // is exactly what `triggerHeld` (last tick's state) distinguishes.
  const triggerPulled = WEAPON.automatic ? intent.fire : intent.fire && !state.triggerHeld;

  if (!intent.fire) {
    // Releasing the trigger resets the cadence so the *first* shot of the next
    // pull is immediate rather than waiting out the remainder of a stale cycle.
    state.fireCooldown = 0;
  }

  if (triggerPulled && state.mode !== 'reloading') {
    if (state.magazine <= 0) {
      dryFire = true;
      if (canStartReload) {
        state.mode = 'reloading';
        state.reloadElapsed = 0;
        state.reloadStartTime = time;
        state.reloadFromEmpty = true;
        state.reloadDuration = reloadDurationFor(true);
        state.reloadCancellable = true;
        reloadStarted = true;
      }
    } else if (state.fireCooldown <= 0) {
      fired = true;
      state.magazine -= 1;
      state.shotsSinceReload += 1;
      state.fireCooldown += fireInterval();
      // Never let the accumulator bank more than one cycle of credit.
      if (state.fireCooldown < -fireInterval()) {
        state.fireCooldown = -fireInterval();
      }
      if (state.magazine === 0) magazineEmptied = true;

      // Sample the cone this bullet actually uses: recovery for this tick has
      // already been applied above, so `spreadDeg` is the widest the player has
      // earned — bloom from *this* shot is added afterwards.
      shotSpread = state.spreadDeg;
      state.spreadDeg = Math.min(WEAPON.spreadMaxDeg, state.spreadDeg + WEAPON.spreadPerShotDeg);

      recoilPitchDeg = WEAPON.recoilPitchDeg;
      recoilYawDeg = state.rng.range(-WEAPON.recoilYawDeg, WEAPON.recoilYawDeg);
      state.lastShotTime = time;
      state.mode = 'firing';
    }
  } else if (state.mode === 'firing') {
    state.mode = 'idle';
  }

  state.triggerHeld = intent.fire;

  return {
    fired,
    spreadDeg: shotSpread,
    recoilPitchDeg,
    recoilYawDeg,
    reloadStarted,
    reloadFinished,
    reloadCancelled,
    magazineEmptied,
    dryFire,
  };
}

/**
 * Advances the camera recoil recovery and returns the remaining swing.
 *
 * The model is the standard two-part one: every shot adds an angular impulse to
 * an accumulator, and the accumulator relaxes toward zero on an exponential
 * curve. The player pulls down against what is left, which is what makes a
 * recoil pattern learnable rather than random. An exponential (rather than
 * linear) return is deliberate: the first tenth of a second recovers most of the
 * kick, so tapping is rewarding, while sustained fire settles into a stable
 * plateau the player can hold against.
 *
 * @returns the pitch/yaw the camera should be offset by this tick, in degrees.
 */
export function tickRecoil(state: WeaponState, dt: number): { pitchDeg: number; yawDeg: number } {
  const decay = Math.exp(-WEAPON.recoilRecoveryPerSec * dt);
  state.recoilPitchDeg *= decay;
  state.recoilYawDeg *= decay;
  return { pitchDeg: state.recoilPitchDeg, yawDeg: state.recoilYawDeg };
}

/** Adds a shot's recoil impulse to the accumulator. */
export function applyRecoilImpulse(state: WeaponState, pitchDeg: number, yawDeg: number): void {
  state.recoilPitchDeg += pitchDeg;
  state.recoilYawDeg += yawDeg;
}

/** Clamps a magazine/reserve pair into legal range. Test and cheat helper. */
export function refill(state: WeaponState): void {
  state.magazine = clamp(WEAPON.magazineSize, 0, WEAPON.magazineSize);
  state.reserve = clamp(WEAPON.maxReserveAmmo, 0, WEAPON.maxReserveAmmo);
}

/**
 * Adds rounds to the reserve, and returns how many actually fit (phase 11).
 *
 * The return value is the honest number rather than the requested one. An ammo crate used
 * with a full reserve grants nothing, and the HUD says so instead of promising 90 and
 * delivering none — the same rule the medkit's heal follows, and the reason
 * `pickup:collected` carries an `amount` at all.
 *
 * The **magazine is deliberately not topped up**: a crate is a supply, not a reload. Filling
 * the magazine would make the crate the thing that performs a reload, which would quietly
 * remove the reload (and its vulnerable 2.1 s window) from the fights the crates exist for.
 */
export function grantReserveAmmo(state: WeaponState, rounds: number): number {
  const before = state.reserve;
  state.reserve = clamp(state.reserve + Math.max(0, rounds), 0, WEAPON.maxReserveAmmo);
  return state.reserve - before;
}
