/**
 * HUD formatting and hit-log instrumentation tests.
 *
 * Both modules are DOM-adjacent, but the parts worth testing are pure: number
 * formatting, the colour thresholds, the crosshair projection, and the frame
 * tolerances of the `[HITLOG]` chain. Testing those here is what keeps the DOM
 * wiring thin enough to read.
 */

import { describe, expect, it } from 'vitest';
import {
  chargesEmpty,
  crosshairRadius,
  formatAmmo,
  formatHealth,
  healthTone,
  overlayVisibility,
  type OverlayMode,
} from '#/render/hud/hud';
import { CHANNEL_TOLERANCE_FRAMES, createHitLog } from '#/debug/hitlog';
import { PLAYER, SIM, WEAPON } from '#/core/config';
import { createWeaponState } from '#/game/player/weapon';
import type { GameEvents } from '#/core/events';

describe('HUD formatting', () => {
  it('rounds health up so a living player never reads as 0', () => {
    expect(formatHealth(1, 150)).toBe('1 / 150');
    expect(formatHealth(0.2, 150)).toBe('1 / 150');
    expect(formatHealth(150, 150)).toBe('150 / 150');
    expect(formatHealth(-5, 150)).toBe('0 / 150');
  });

  it('moves the health colour through three bands', () => {
    expect(healthTone(1)).toBe(healthTone(0.7));
    expect(healthTone(0.7)).not.toBe(healthTone(0.4));
    expect(healthTone(0.4)).not.toBe(healthTone(0.1));
  });

  it('reports an empty magazine and a reload distinctly', () => {
    const full = createWeaponState(1);
    expect(formatAmmo(full).state).toBe('');
    expect(formatAmmo(full).magazine).toBe(String(WEAPON.magazineSize));

    const low = createWeaponState(1);
    low.magazine = Math.ceil(WEAPON.magazineSize * 0.2);
    expect(formatAmmo(low).state.length).toBeGreaterThan(0);

    const empty = createWeaponState(1);
    empty.magazine = 0;
    expect(formatAmmo(empty).state).toContain('R');

    const tactical = createWeaponState(1);
    tactical.magazine = 10;
    tactical.mode = 'reloading';
    tactical.reloadFromEmpty = false;
    const dry = createWeaponState(1);
    dry.magazine = 0;
    dry.mode = 'reloading';
    dry.reloadFromEmpty = true;
    // The two reload paths must read differently, or the player cannot tell why
    // one finished faster than the other.
    expect(formatAmmo(tactical).state).not.toBe(formatAmmo(dry).state);
  });

  it('projects the spread cone to a crosshair radius that tracks zoom', () => {
    const hip = crosshairRadius(WEAPON.spreadHipDeg, PLAYER.fovHip, 900);
    const ads = crosshairRadius(WEAPON.spreadAdsDeg, PLAYER.fovAds, 900);
    expect(hip).toBeGreaterThan(ads);
    // A tiny cone at high zoom must still draw something visible.
    expect(crosshairRadius(0, PLAYER.fovAds, 900)).toBeGreaterThan(0);
    // And the radius scales with viewport height.
    expect(crosshairRadius(1, PLAYER.fovHip, 1800)).toBeCloseTo(
      crosshairRadius(1, PLAYER.fovHip, 900) * 2,
      6,
    );
  });
});

describe('overlay visibility contract', () => {
  const MODES: readonly OverlayMode[] = ['boot', 'paused', 'result', 'none'];

  it('shows exactly one of the three layers, and the HUD only when there is no overlay', () => {
    // The defect this replaces was a veil left visible for the entire session while the HUD
    // was hidden underneath it: every state assertion passed and the screen was black.
    // "More than one visible" and "none of them" are the two states that make that possible,
    // so they are excluded by name.
    for (const mode of MODES) {
      const visibility = overlayVisibility(mode);
      const shown = [!visibility.veilHidden, !visibility.pauseHidden, !visibility.hudHidden].filter(Boolean);
      expect(shown, `mode ${mode}`).toHaveLength(1);
    }
  });

  it('hides the overlay layers in play, which is the only state the player can act in', () => {
    const playing = overlayVisibility('none');
    expect(playing.veilHidden).toBe(true);
    expect(playing.pauseHidden).toBe(true);
    expect(playing.hudHidden).toBe(false);
  });

  it('shows the pause panel for the paused mode, not the veil', () => {
    // Esc used to reopen the veil, i.e. the opaque title screen: the player saw what looked
    // like a return to the main menu, with no way to restart or to leave the run.
    const paused = overlayVisibility('paused');
    expect(paused.pauseHidden).toBe(false);
    expect(paused.veilHidden).toBe(true);
    expect(paused.hudHidden).toBe(true);
  });

  it('treats the results screen as one more veil, not a fourth state', () => {
    // Phase 3 added two more reasons for the veil to be up (victory and defeat). They go
    // through the same `showVeil` call as the boot screen, which is the point: there is
    // exactly one function that decides the three layers' visibility, and a "results
    // overlay" built as its own element is how the original black-screen defect comes back.
    expect(overlayVisibility('result')).toEqual(overlayVisibility('boot'));
  });
});

describe('item charge readout', () => {
  it('reads as empty only when the belt holds nothing', () => {
    expect(chargesEmpty(0)).toBe(true);
    expect(chargesEmpty(1)).toBe(false);
    expect(chargesEmpty(5)).toBe(false);
    // Defensive: a negative count can never be reported, but it must not read as
    // "you have charges" either.
    expect(chargesEmpty(-1)).toBe(true);
  });
});

describe('hit log', () => {
  const shotFired = (shotId: number, tick: number): GameEvents['shot:fired'] => ({
    tick,
    shotId,
    origin: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    spreadDeg: 0,
  });

  it('stays silent until enabled', () => {
    const log = createHitLog();
    log.onShotFired(shotFired(1, 0));
    expect(log.records().length).toBe(0);
  });

  it('records a shot and closes it out when the next one starts', () => {
    const log = createHitLog();
    log.enabled = true;
    log.onShotFired(shotFired(1, 0));
    expect(log.records().length).toBe(0);
    log.onShotFired(shotFired(2, 6));
    expect(log.records().length).toBe(1);
    expect(log.records()[0]?.shotId).toBe(1);
    expect(log.records()[0]?.hitAt).toBeNull();
  });

  it('ignores marks that belong to an earlier shot', () => {
    // At 640 RPM the previous shot's impact routinely lands after the next shot
    // has been fired. Attributing it to the new record produces a large negative
    // frame delta that looks exactly like a feedback bug which is not there.
    const log = createHitLog();
    log.enabled = true;
    log.onShotFired(shotFired(1, 0));
    log.onShotFired(shotFired(2, 6));
    log.mark('decal', 7 / SIM.tickHz, 1);
    const second = log.records()[log.records().length - 1];
    expect(second?.shotId).toBe(1);
    // Record 1 legitimately owns the mark; record 2 has not been closed yet, so
    // assert through the next close.
    log.onShotFired(shotFired(3, 12));
    const third = log.records()[log.records().length - 1];
    expect(third?.shotId).toBe(2);
    expect(third?.marks.length).toBe(0);
  });

  it('marks the authoritative hit frame as on time', () => {
    const log = createHitLog();
    log.enabled = true;
    log.onShotFired(shotFired(7, 0));
    // The impact resolves on the very next tick.
    log.onHit({
      tick: 1,
      shotId: 7,
      targetId: 3,
      zone: 'head',
      baseDamage: WEAPON.damage,
      finalDamage: 55,
      distance: 9,
      point: { x: 0, y: 1, z: -9 },
      hitstop: 0.05,
    });
    const record = log.records().length > 0 ? log.records()[log.records().length - 1] : undefined;
    // The record is still open until the next shot, so assert through the render.
    const rendered = log.render(4);
    expect(rendered).toContain('[HITLOG]');
    expect(rendered).toContain('tolerances');
    expect(rendered).not.toContain('OUT OF TOLERANCE');
    void record;
  });

  it('flags a link that misses its tolerance', () => {
    const log = createHitLog();
    log.enabled = true;
    log.onShotFired(shotFired(11, 0));
    // A hit on tick 1, then a damage-number mark ten frames later: far outside
    // the ±2 frame budget the technical plan specifies.
    log.onHit({
      tick: 1,
      shotId: 11,
      targetId: 2,
      zone: 'body',
      baseDamage: WEAPON.damage,
      finalDamage: WEAPON.damage,
      distance: 5,
      point: { x: 0, y: 1, z: -5 },
      hitstop: 0.03,
    });
    log.mark('number', 11 / SIM.tickHz);
    log.onShotFired(shotFired(12, 12));
    expect(log.records().some((record) => record.violated)).toBe(true);
    expect(log.render(4)).toContain('OUT OF TOLERANCE');
  });

  it('keeps every channel inside a tolerance of at most 2 frames, VFX at 0', () => {
    // These numbers are the published feedback budget; a change here is a design
    // decision, not a refactor.
    expect(CHANNEL_TOLERANCE_FRAMES.vfx).toBe(0);
    expect(CHANNEL_TOLERANCE_FRAMES.hitbox).toBe(0);
    expect(CHANNEL_TOLERANCE_FRAMES.damage).toBe(0);
    expect(CHANNEL_TOLERANCE_FRAMES.number).toBeLessThanOrEqual(2);
    expect(CHANNEL_TOLERANCE_FRAMES.sfx).toBeLessThanOrEqual(1);
    expect(CHANNEL_TOLERANCE_FRAMES.shake).toBeLessThanOrEqual(1);
  });

  it('bounds how many records it retains', () => {
    const log = createHitLog(4);
    log.enabled = true;
    for (let i = 0; i < 20; i += 1) log.onShotFired(shotFired(i + 1, i * 4));
    expect(log.records().length).toBeLessThanOrEqual(4);
  });

  it('clears on demand', () => {
    const log = createHitLog();
    log.enabled = true;
    log.onShotFired(shotFired(1, 0));
    log.onShotFired(shotFired(2, 4));
    expect(log.records().length).toBe(1);
    log.clear();
    expect(log.records().length).toBe(0);
  });

  it('renders the documented line format', () => {
    const log = createHitLog();
    log.enabled = true;
    log.onShotFired(shotFired(88, 0));
    log.onHit({
      tick: 1,
      shotId: 88,
      targetId: 1,
      zone: 'head',
      baseDamage: WEAPON.damage,
      finalDamage: 55,
      distance: 8,
      point: { x: 0, y: 1, z: -8 },
      hitstop: 0.05,
    });
    // The record stays open until the next shot, so its render is checked after a
    // following shot closes it — which is also how the live log behaves.
    log.onShotFired(shotFired(89, 8));
    const text = log.render(4);
    expect(text).toMatch(/\[HITLOG\] shot=88/);
    expect(text).toMatch(/evt=hitbox/);
  });
});
