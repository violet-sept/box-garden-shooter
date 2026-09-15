/**
 * HUD layer.
 *
 * Plain DOM rather than a canvas overlay, for two reasons: text rendering is free
 * and crisp at any DPI, and the layout is described in CSS rather than in draw
 * calls. The budget in the technical plan allows 0.5 ms per frame, which DOM text
 * updates meet easily *provided* nothing here forces a reflow — so every value is
 * written through a change check, and the crosshair is resized with a CSS custom
 * property rather than by moving four separate elements.
 *
 * All gameplay state arrives as plain numbers. This module formats; it never
 * decides.
 */

import { CROSSHAIR, PLAYER, WEAPON } from '../../core/config';
import { spreadToScreenRadius } from '../../game/camera/camera';
import type { WeaponState } from '../../game/player/weapon';
import type { LoopMetrics } from '../../core/loop';

/** Cached handle on each HUD element, so no lookups happen per frame. */
export interface HudElements {
  /** The HUD layer itself. Hidden exactly when one of the two overlays is up. */
  readonly root: HTMLElement;
  /**
   * The opaque boot/pause overlay.
   *
   * It is a separate element from {@link root} and the two are *opposites*:
   * the veil covers the canvas while the pointer is unlocked, and the HUD is
   * visible while it is locked. Collapsing them into one element (as an earlier
   * revision did) leaves an opaque `position: fixed; inset: 0` panel on top of
   * the canvas forever, and the game is unplayable while every state assertion
   * still passes — see the technical plan section 5.6.7.
   */
  readonly veil: HTMLElement;
  /**
   * The semi-transparent pause panel Esc produces.
   *
   * A third full-screen layer rather than one more message on the veil, and that is a
   * fix rather than an addition: the veil is opaque and its click means "start", so
   * reusing it for a pause made Esc look exactly like a return to the title screen and
   * left the player with no way to say "restart" or "main menu". `overlayVisibility` is
   * still the single arbiter of which of the three is up.
   */
  readonly pause: HTMLElement;
  readonly crosshair: HTMLElement;
  readonly healthFill: HTMLElement;
  readonly healthText: HTMLElement;
  readonly ammoMagazine: HTMLElement;
  readonly ammoReserve: HTMLElement;
  readonly ammoState: HTMLElement;
  readonly chargeCount: HTMLElement;
  readonly spreadHint: HTMLElement;
  readonly stats: HTMLElement;
  readonly hint: HTMLElement;
  /** Full-screen red vignette, flashed when the player takes damage. */
  readonly damageFlash: HTMLElement;
}

/** The HUD's public surface. */
export interface Hud {
  /** Full-fidelity update. Called once per rendered frame. */
  update(view: HudView): void;
  /** Shows the boot or results veil with its text. Hides the pause menu and the HUD. */
  showVeil(message: string, detail: string): void;
  /** Shows the pause menu. Hides the veil and the HUD; the frozen scene stays visible. */
  showPause(): void;
  /** Hides every overlay and reveals the HUD. Exactly one layer is ever visible. */
  hideOverlays(): void;
  /** Flashes the red damage vignette. `intensity` is clamped to `[0, 1]`. */
  flashDamage(intensity?: number): void;
  /** Shows a transient centre-screen banner (kill, phase change, warning). */
  banner(text: string, tone?: 'neutral' | 'warn' | 'good'): void;
  dispose(): void;
}

/**
 * Which full-screen layer is up, if any.
 *
 * The three overlays the game has are `boot` (the click-to-start affordance pointer lock
 * requires), `paused` (the panel Esc produces) and `result` (the end of a run). A single
 * "is the veil up" boolean cannot express them: "died, then pressed Esc" would look
 * identical to "died again", and the click that dismisses a pause would restart the run.
 */
export type OverlayMode = 'boot' | 'paused' | 'result' | 'none';

/**
 * Visibility of the three full-screen layers, as plain data.
 *
 * Split out as a pure function on purpose. The bug this project actually shipped
 * was not a hard one — a veil left `hidden = false` forever — but the only thing
 * asserting on it was a desktop probe whose expectation was written backwards,
 * so `ok: true` was reported over a completely black screen (technical plan
 * section 5.6.7). Making the contract a value that a unit test can read is what
 * stops a repaint-driven test from being the only witness.
 */
export interface OverlayVisibility {
  /** Opaque boot / results veil. Covers the canvas, so it must be hidden in play. */
  readonly veilHidden: boolean;
  /** Semi-transparent pause menu. */
  readonly pauseHidden: boolean;
  /** HUD layer. Must be visible exactly when nothing covers the canvas. */
  readonly hudHidden: boolean;
}

/**
 * Computes the visibility triple for a given overlay state.
 *
 * "At most one, and the HUD only when there is none" is the invariant, and it is enforced
 * here rather than at three call sites. The defect this replaces was a veil left visible for
 * a whole session with the HUD hidden underneath: every state assertion passed and the
 * screen was black (plan §5.6.7).
 */
export function overlayVisibility(mode: OverlayMode): OverlayVisibility {
  switch (mode) {
    case 'none':
      return { veilHidden: true, pauseHidden: true, hudHidden: false };
    case 'paused':
      return { veilHidden: true, pauseHidden: false, hudHidden: true };
    default:
      return { veilHidden: false, pauseHidden: true, hudHidden: true };
  }
}

/** Everything the HUD needs for one frame. */
export interface HudView {
  readonly weapon: WeaponState;
  readonly health: number;
  readonly maxHealth: number;
  readonly charges: number;
  readonly spreadDeg: number;
  readonly fovDeg: number;
  /**
   * Aim-down-sights blend in `[0, 1]`, straight from the weapon.
   *
   * Needed here because the reticle **crossfades** with it: hip fire draws the spread cone, and
   * full ADS draws a fixed-size sight instead (see {@link crosshairRadius}). Passing the blend
   * rather than a boolean is what makes the reticle grow *during* the 0.18 s transition
   * instead of snapping at the end of it.
   */
  readonly adsProgress: number;
  readonly viewportHeight: number;
  readonly metrics: LoopMetrics;
  /** Seconds the current banner has left. */
  readonly bannerRemaining: number;
  /** Live enemies, for the debug line. Zero before the first wave. */
  readonly enemiesAlive: number;
  /** True once the player has been killed. */
  readonly dead: boolean;
  /** 1-based wave number the player is on. */
  readonly wave: number;
  /** Waves in the run, for the `wave / total` readout. */
  readonly totalWaves: number;
  /** The run's seed, so a bug report can name the run that produced it. */
  readonly seed: number;
}

/** Formats a number as `current / max`, which is the ammo readout's shape. */
export function formatAmmo(weapon: WeaponState): { magazine: string; reserve: string; state: string } {
  return {
    magazine: String(weapon.magazine),
    reserve: String(weapon.reserve),
    state:
      weapon.mode === 'reloading'
        ? weapon.reloadFromEmpty
          ? '换弹（空仓）'
          : '换弹'
        : weapon.magazine === 0
          ? '弹匣空 — 按 R'
          : weapon.magazine / WEAPON.magazineSize <= 0.25
            ? '弹药不足'
            : '',
  };
}

/** Formats the health readout. Rounds up so 1 HP never displays as 0. */
export function formatHealth(health: number, max: number): string {
  return `${Math.max(0, Math.ceil(health))} / ${max}`;
}

/**
 * Whether the charge readout should read as empty.
 *
 * A named function rather than an inline `view.charges === 0`, because "the belt is
 * empty" is the cue that the `E` key is about to do nothing — the one readout whose
 * *absence* the player needs to notice before pressing it, not after.
 */
export function chargesEmpty(charges: number): boolean {
  return charges <= 0;
}

/** Colours the health bar from a fraction in [0, 1]. */
export function healthTone(fraction: number): string {
  if (fraction > 0.6) return '#5ddc8a';
  if (fraction > 0.3) return '#ffcf5d';
  return '#ff6152';
}

/**
 * Converts a spread cone to the crosshair's radius in CSS pixels.
 *
 * The projection itself is `game/camera/spreadToScreenRadius` — the *one* implementation, which
 * the camera tests already pin. It is a pure angle → pixels function that happens to live next to
 * the aim solve, and it takes the viewport height as an argument precisely so no layer has to
 * know about the screen. There used to be a second copy in `render/camera/cameraRig.ts`; it is
 * gone, because two copies of a rule is two chances for one of them to be stale.
 *
 * ## The two reticles, and why the aimed one is bigger
 *
 * The **hip-fire** term is exactly the old spread projection: the ring opens as the cone blooms,
 * which is the readout that teaches trigger discipline. The **aimed** term crossfades from the
 * resting hip-fire radius to `CROSSHAIR.adsRadiusPx` — a fixed, deliberately larger ring —
 * because the projection collapses to a few pixels once the cone is 0.35° *and* the view is
 * zoomed, and a dot is not a sight picture.
 *
 * The result is the larger of the two, and that `max` is load-bearing. Blending straight from the
 * *live* projection to the aimed ring would make the reticle **shrink first and grow later**: the
 * spread collapses within ~0.13 s of the 0.18 s ADS transition, so the live term drops to a dot
 * while the aimed term has barely started moving. Taking the larger keeps the ring monotone —
 * never smaller than the hip reticle, growing to the aimed one — and still lets a bloomed cone
 * open the ring wide while aiming.
 */
export function crosshairRadius(
  spreadDeg: number,
  fovDeg: number,
  viewportHeight: number,
  adsProgress = 0,
): number {
  const live = Math.max(CROSSHAIR.minRadiusPx, spreadToScreenRadius(spreadDeg, fovDeg, viewportHeight));
  const blend = Math.max(0, Math.min(1, adsProgress));
  // Not aiming: the reticle *is* the cone, byte for byte what it was before this feature.
  if (blend <= 0) return live;
  const resting = Math.max(
    CROSSHAIR.minRadiusPx,
    spreadToScreenRadius(WEAPON.spreadHipDeg, PLAYER.fovHip, viewportHeight),
  );
  const aimed = resting + (CROSSHAIR.adsRadiusPx - resting) * blend;
  return Math.max(live, aimed);
}

/**
 * Whether the reticle should be styled as the aimed one.
 *
 * A class rather than a second size, because the size already carries the state: this only
 * thickens the ring and lights it in the HUD's accent colour, which is what makes "I am aiming"
 * readable at a glance on a busy screen. Thresholded rather than blended because a border can
 * only be one of two weights, and it uses the same `1.0` boundary as `weapon.aiming`.
 */
export function crosshairAiming(adsProgress: number): boolean {
  return adsProgress >= 1;
}

/** Creates the HUD controller over the elements in `index.html`. */
export function createHud(elements: HudElements): Hud {
  let lastCrosshair = -1;
  let lastHealthText = '';
  let lastHealthTone = '';
  let lastHealthWidth = -1;
  let lastMagazine = '';
  let lastReserve = '';
  let lastAmmoState = '';
  let lastCharges = -1;
  let lastStatsLines = '';
  let lastDead = false;
  let lastAiming = false;
  let bannerTimer: number | null = null;

  /**
   * The one place `overlayVisibility` is applied to the document.
   *
   * Every overlay transition goes through here, so "at most one layer, and the HUD only
   * when there is none" is a property of the code rather than of three call sites that
   * have to agree. It is also idempotent, which is what lets the composition root call it
   * on both the lock and the unlock side of the same gesture.
   */
  const applyOverlay = (mode: OverlayMode): void => {
    const visibility = overlayVisibility(mode);
    elements.veil.hidden = visibility.veilHidden;
    elements.pause.hidden = visibility.pauseHidden;
    elements.root.hidden = visibility.hudHidden;
  };

  return {
    update(view) {
      // --- Crosshair: one custom property, no layout thrash -------------------
      const radius = crosshairRadius(view.spreadDeg, view.fovDeg, view.viewportHeight, view.adsProgress);
      if (Math.abs(radius - lastCrosshair) > 0.35) {
        elements.crosshair.style.setProperty('--spread', `${radius.toFixed(1)}px`);
        lastCrosshair = radius;
      }
      const aiming = crosshairAiming(view.adsProgress);
      if (aiming !== lastAiming) {
        elements.crosshair.classList.toggle('ads', aiming);
        lastAiming = aiming;
      }

      // --- Health -------------------------------------------------------------
      const fraction = view.maxHealth > 0 ? view.health / view.maxHealth : 0;
      const healthText = formatHealth(view.health, view.maxHealth);
      if (healthText !== lastHealthText) {
        elements.healthText.textContent = healthText;
        lastHealthText = healthText;
      }
      const tone = healthTone(fraction);
      if (tone !== lastHealthTone) {
        elements.healthFill.style.background = tone;
        lastHealthTone = tone;
      }
      const width = Math.round(Math.max(0, Math.min(1, fraction)) * 1000) / 10;
      if (width !== lastHealthWidth) {
        elements.healthFill.style.width = `${width}%`;
        lastHealthWidth = width;
      }

      // --- Ammo ---------------------------------------------------------------
      const ammo = formatAmmo(view.weapon);
      if (ammo.magazine !== lastMagazine) {
        elements.ammoMagazine.textContent = ammo.magazine;
        lastMagazine = ammo.magazine;
      }
      if (ammo.reserve !== lastReserve) {
        elements.ammoReserve.textContent = `/ ${ammo.reserve}`;
        lastReserve = ammo.reserve;
      }
      if (ammo.state !== lastAmmoState) {
        elements.ammoState.textContent = ammo.state;
        elements.ammoState.classList.toggle('warn', ammo.state.length > 0);
        lastAmmoState = ammo.state;
      }

      // --- Charges ------------------------------------------------------------
      if (view.charges !== lastCharges) {
        elements.chargeCount.textContent = String(view.charges);
        elements.chargeCount.classList.toggle('empty', chargesEmpty(view.charges));
        lastCharges = view.charges;
      }

      // --- Spread readout -----------------------------------------------------
      elements.spreadHint.style.opacity = view.spreadDeg > 1.2 ? '1' : '0';

      // --- Debug stats --------------------------------------------------------
      // Rebuilt as a single string only when it changes, so an idle HUD costs
      // zero DOM writes rather than one per field per frame.
      const m = view.metrics;
      const lines =
        `FPS ${m.fps.toFixed(0).padStart(3)}   TPS ${m.tps.toFixed(0).padStart(3)}\n` +
        `step ${m.stepMs.toFixed(2)}ms  draw ${m.renderMs.toFixed(2)}ms\n` +
        `steps/frame ${m.stepsLastFrame}  dropped ${m.droppedStepFrames}\n` +
        `spread ${view.spreadDeg.toFixed(2)}°  fov ${view.fovDeg.toFixed(1)}°\n` +
        `wave ${view.wave}/${view.totalWaves}  enemies ${view.enemiesAlive}\n` +
        `seed ${view.seed >>> 0}`;
      if (lines !== lastStatsLines) {
        elements.stats.textContent = lines;
        lastStatsLines = lines;
      }

      // --- Death --------------------------------------------------------------
      // One class on the root drives the "you are down" treatment for the health
      // bar and the crosshair; per-element writes would be three more state
      // variables for no extra information.
      if (view.dead !== lastDead) {
        elements.root.classList.toggle('dead', view.dead);
        elements.crosshair.classList.toggle('dead', view.dead);
        lastDead = view.dead;
      }
    },

    showVeil(message, detail) {
      applyOverlay('boot');
      elements.hint.innerHTML = `<strong>${message}</strong><span>${detail}</span>`;
    },

    showPause() {
      applyOverlay('paused');
    },

    hideOverlays() {
      applyOverlay('none');
    },

    flashDamage(intensity = 1) {
      // Clamp first: a 34-damage shot arriving after a 9-damage swipe must
      // not stack two animations into a full-screen red wash.
      const amount = Math.max(0, Math.min(1, intensity));
      elements.damageFlash.style.setProperty('--damage', amount.toFixed(3));
      // Restart the CSS animation by removing and re-adding the class. The
      // forced reflow between the two is what defeats the browser's animation
      // coalescing; without it a second hit inside 420 ms is silently ignored.
      elements.damageFlash.classList.remove('hit');
      void elements.damageFlash.offsetWidth;
      elements.damageFlash.classList.add('hit');
    },

    banner(text, tone = 'neutral') {
      const existing = document.getElementById('hud-banner');
      const element = existing ?? document.createElement('div');
      element.id = 'hud-banner';
      element.className = `banner ${tone}`;
      element.textContent = text;
      if (!existing) document.body.appendChild(element);
      // Restart the CSS animation on repeat messages.
      element.style.animation = 'none';
      void element.offsetHeight;
      element.style.animation = '';
      if (bannerTimer !== null) window.clearTimeout(bannerTimer);
      bannerTimer = window.setTimeout(() => {
        element.remove();
        bannerTimer = null;
      }, 1600);
    },

    dispose() {
      if (bannerTimer !== null) window.clearTimeout(bannerTimer);
    },
  };
}
