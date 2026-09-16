/**
 * Camera rig tests.
 *
 * The camera is where "the crosshair is lying to me" bugs live, and they are
 * miserable to diagnose in a browser because the symptom (a shot landing a few
 * centimetres off at range) looks like a hitbox problem. Everything asserted here
 * is an invariant the aim chain depends on:
 *
 *   1. The muzzle sits exactly on the camera's forward axis, so the shot traced
 *      from the muzzle toward the crosshair travels along the view axis.
 *   2. The spread cone converges to zero, so a perfectly aimed shot cannot miss.
 *   3. ADS actually changes FOV and lateral offset, and the two ends of the
 *      transition are the values in config.
 *   4. The rounded crosshair radius matches the cone it is drawn for.
 */

import { describe, expect, it } from 'vitest';
import { CAMERA, PLAYER, VIEW, WEAPON } from '#/core/config';
import { createRng } from '#/core/math/rng';
import { aabb } from '#/core/math/intersect';
import { DEG2RAD, dot, length, vec3 } from '#/core/math/vec3';
import {
  VIEW_MODES,
  createAimSolution,
  createCameraScratch,
  createCameraState,
  nextViewMode,
  snapCamera,
  solveAim,
  spreadToScreenRadius,
  updateCamera,
  type ViewMode,
} from '#/game/camera/camera';
import { createMovementScratch, createCollisionWorld, createPlayerState, resetPlayerState, tickPlayer } from '#/game/player/player';
import { createWeaponState, tickWeapon } from '#/game/player/weapon';
import { buildLevel, decorCollisionBoxes } from '#/game/level';

/**
 * Builds a player + camera at a given yaw/pitch, already aimed.
 *
 * The view mode defaults to **third person** here, which is *not* the game's default: this block
 * is the over-the-shoulder rig's own test, and the mode it was written against should be the one
 * stated. The first-person rig has its own block below, and the world-level tests state the mode
 * they drive, because "which mode does `createWorld` boot into" is a fact with one right answer
 * (`CAMERA.defaultView`) that a test should not be able to pass by accident.
 */
function makeRig(yaw: number, pitch: number, ads = 0, viewMode: ViewMode = 'thirdPerson') {
  const weapon = createWeaponState(1);
  weapon.adsProgress = ads;
  weapon.aiming = ads >= 1;
  const player = createPlayerState(weapon);
  player.yaw = yaw;
  player.pitch = pitch;
  const camera = createCameraState();
  camera.viewMode = viewMode;
  camera.yaw = yaw;
  camera.pitch = pitch;
  const scratch = createCameraScratch();
  const aim = createAimSolution();
  return { player, camera, scratch, aim, weapon };
}

describe('aim solve', () => {
  it('keeps the muzzle exactly on the aim axis at every pitch', () => {
    for (const pitch of [-1.45, -0.9, -0.3, 0, 0.4, 1.0, 1.45]) {
      for (const yaw of [0, 0.9, -2.2, 3.0]) {
        const { player, scratch, aim } = makeRig(yaw, pitch);
        solveAim(aim, scratch, player, []);
        // Direction from the muzzle to the aim point must be the camera forward.
        const d = vec3(
          aim.aimPoint.x - aim.muzzle.x,
          aim.aimPoint.y - aim.muzzle.y,
          aim.aimPoint.z - aim.muzzle.z,
        );
        const len = length(d);
        d.x /= len;
        d.y /= len;
        d.z /= len;
        // Recompute the forward vector independently of the camera module.
        const cp = Math.cos(pitch);
        const forward = vec3(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);

        // What must hold exactly: the muzzle offset is perpendicular to the aim
        // axis, so the direction from muzzle to aim point is `forward` scaled by
        // `range / hypot(range, |offset|)`.
        const offsetX = aim.muzzle.x - aim.pivot.x;
        const offsetY = aim.muzzle.y - aim.pivot.y;
        const offsetZ = aim.muzzle.z - aim.pivot.z;
        const offsetForward = offsetX * forward.x + offsetY * forward.y + offsetZ * forward.z;
        expect(Math.abs(offsetForward), `pitch ${pitch}`).toBeLessThan(1e-12);

        const offsetLength = Math.sqrt(offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ);
        const expectedDot = 1 / Math.sqrt(1 + (offsetLength / WEAPON.range) ** 2);
        expect(dot(d, forward), `yaw ${yaw} pitch ${pitch}`).toBeCloseTo(expectedDot, 9);
      }
    }
  });

  it('reports exactly the camera forward as the shot direction', () => {
    const { player, scratch, aim } = makeRig(0.7, -0.5);
    solveAim(aim, scratch, player, []);
    expect(length(aim.direction)).toBeCloseTo(1, 12);
    const cp = Math.cos(-0.5);
    expect(aim.direction.x).toBeCloseTo(-Math.sin(0.7) * cp, 12);
    expect(aim.direction.y).toBeCloseTo(Math.sin(-0.5), 12);
    expect(aim.direction.z).toBeCloseTo(-Math.cos(0.7) * cp, 12);
  });

  it('puts the muzzle below and to the right of the pivot', () => {
    const { player, scratch, aim } = makeRig(0, 0);
    solveAim(aim, scratch, player, []);
    // Level camera, yaw 0: right is +X, up is +Y.
    expect(aim.muzzle.x).toBeCloseTo(aim.pivot.x + CAMERA.muzzleSide, 9);
    expect(aim.muzzle.y).toBeCloseTo(aim.pivot.y - CAMERA.muzzleDrop, 9);
  });

  it('places the camera behind the pivot by the configured boom length', () => {
    const { player, scratch, aim } = makeRig(0, 0);
    solveAim(aim, scratch, player, []);
    // Yaw 0, pitch 0: forward is 闁愁厽濡? so the camera sits at pivot + Z * hipDistance.
    expect(aim.desiredPosition.z).toBeCloseTo(aim.pivot.z + CAMERA.hipDistance, 9);
    expect(aim.desiredPosition.y).toBeCloseTo(aim.pivot.y, 9);
  });

  it('follows the player position', () => {
    const { player, scratch, aim } = makeRig(0, 0);
    player.position.x = 5;
    player.position.z = -3;
    player.position.y = 3;
    solveAim(aim, scratch, player, []);
    // Pivot is 0.42 m to the player's right at the configured height.
    expect(aim.pivot.x).toBeCloseTo(5 + CAMERA.pivotRight, 9);
    expect(aim.pivot.y).toBeCloseTo(3 + CAMERA.pivotUp, 9);
    expect(aim.pivot.z).toBeCloseTo(-3, 9);
  });
});

/**
 * The first-person rig (phase 8).
 *
 * `V` is a *view* switch, and the one thing it must never be is a *shot* switch: the crosshair,
 * the tracer and the impact all come from one aim solution, so a mode is only allowed to move
 * where the camera and the muzzle are — never where the bullet goes. Half of this block is that
 * invariant stated twice (the direction is identical in both modes), and the other half is the
 * geometry that makes first person first person: the camera is the eye, exactly, with no boom and
 * no shoulder offset.
 */
describe('first-person view', () => {
  it('is the mode a fresh camera state boots into', () => {
    // The brief's requirement, asserted where it is decided.
    expect(createCameraState().viewMode).toBe('firstPerson');
    expect(CAMERA.defaultView).toBe('firstPerson');
  });

  it('cycles through every mode and comes back', () => {
    // Two modes today, but the list is the authority: a third one added to `VIEW_MODES` would be
    // reachable without touching the toggle.
    let mode = createCameraState().viewMode;
    const seen = new Set([mode]);
    for (let i = 0; i < VIEW_MODES.length; i += 1) {
      mode = nextViewMode(mode);
      seen.add(mode);
    }
    expect(seen.size).toBe(VIEW_MODES.length);
    expect(mode).toBe(createCameraState().viewMode);
  });

  it('puts the pivot at the eye, with no lateral offset and no boom', () => {
    const { player, scratch, aim } = makeRig(0, 0, 0, 'firstPerson');
    player.position.x = 5;
    player.position.z = -3;
    player.position.y = 2;
    solveAim(aim, scratch, player, [], 'firstPerson');

    expect(aim.pivot.x).toBeCloseTo(5, 9);
    expect(aim.pivot.z).toBeCloseTo(-3, 9);
    expect(aim.pivot.y).toBeCloseTo(2 + PLAYER.eyeHeight, 9);
    // The camera *is* the pivot: the boom is zero, not merely short.
    expect(aim.desiredPosition.x).toBeCloseTo(aim.pivot.x, 9);
    expect(aim.desiredPosition.y).toBeCloseTo(aim.pivot.y, 9);
    expect(aim.desiredPosition.z).toBeCloseTo(aim.pivot.z, 9);
  });

  it('takes the muzzle off the shoulder and onto the aim axis', () => {
    const third = makeRig(0, 0, 0, 'thirdPerson');
    solveAim(third.aim, third.scratch, third.player, [], 'thirdPerson');
    // The over-the-shoulder tracer is deliberately beside the crosshair...
    expect(third.aim.muzzle.x - third.aim.pivot.x).toBeCloseTo(CAMERA.muzzleSide, 9);

    const first = makeRig(0, 0, 0, 'firstPerson');
    solveAim(first.aim, first.scratch, first.player, [], 'firstPerson');
    // ...and the first-person one is not: the barrel is under the crosshair, so the lateral term
    // is zero and only the drop is left. Reusing the shoulder pair here would send every tracer on
    // a diagonal that grows with range.
    expect(first.aim.muzzle.x).toBeCloseTo(first.aim.pivot.x, 9);
    expect(first.aim.muzzle.y).toBeCloseTo(first.aim.pivot.y - VIEW.muzzleDrop.firstPerson, 9);
  });

  it('fires along the same direction in both views', () => {
    // The whole safety argument for a mid-fight toggle, stated as an assertion: the view changes
    // where the camera and the muzzle are, and nothing else. A player who switches mid-burst must
    // not have to re-learn where their bullets go.
    for (const [yaw, pitch] of [[0, 0], [0.7, -0.5], [-2.4, 1.1], [3.0, 0.2]] as const) {
      const third = makeRig(yaw, pitch, 0, 'thirdPerson');
      solveAim(third.aim, third.scratch, third.player, [], 'thirdPerson');
      const first = makeRig(yaw, pitch, 0, 'firstPerson');
      solveAim(first.aim, first.scratch, first.player, [], 'firstPerson');

      expect(first.aim.direction.x, `yaw ${yaw}`).toBeCloseTo(third.aim.direction.x, 12);
      expect(first.aim.direction.y, `yaw ${yaw}`).toBeCloseTo(third.aim.direction.y, 12);
      expect(first.aim.direction.z, `yaw ${yaw}`).toBeCloseTo(third.aim.direction.z, 12);
      // Same FOV too: ADS is an optical change and belongs to the weapon, not to the view.
      expect(first.aim.fovDeg).toBeCloseTo(third.aim.fovDeg, 12);
    }
  });

  it('keeps the muzzle on the aim axis in first person at every angle', () => {
    // The `camera.test` invariant from the top of this file, re-run in the other mode: the muzzle
    // offset is a sum of components orthogonal to `forward`, in both.
    for (const pitch of [-1.4, -0.4, 0, 0.6, 1.4]) {
      const { player, scratch, aim } = makeRig(1.1, pitch, 0, 'firstPerson');
      solveAim(aim, scratch, player, [], 'firstPerson');
      const cp = Math.cos(pitch);
      const forward = vec3(-Math.sin(1.1) * cp, Math.sin(pitch), -Math.cos(1.1) * cp);
      const offsetX = aim.muzzle.x - aim.pivot.x;
      const offsetY = aim.muzzle.y - aim.pivot.y;
      const offsetZ = aim.muzzle.z - aim.pivot.z;
      const offsetForward = offsetX * forward.x + offsetY * forward.y + offsetZ * forward.z;
      expect(Math.abs(offsetForward), `pitch ${pitch}`).toBeLessThan(1e-12);
    }
  });

  it('never pinches, however tight the geometry', () => {
    // Third person shortens its boom against a crate; first person has no boom to shorten, so the
    // same wall must leave the camera exactly where the eye is.
    const { player, scratch, aim, camera } = makeRig(0, 0, 0, 'firstPerson');
    solveAim(aim, scratch, player, [], 'firstPerson');
    // Start the frame the way a real one does — the camera already on its solved pose. Leaving it
    // at the origin would make this a test of the damping rate rather than of the pinch rule.
    snapCamera(camera, aim, player);

    const wall = aabb(aim.pivot.x, aim.pivot.y, aim.pivot.z + 0.6, 3, 3, 0.5);
    solveAim(aim, scratch, player, [wall], 'firstPerson');
    expect(aim.desiredPosition.z).toBeCloseTo(aim.pivot.z, 9);

    updateCamera(camera, player, aim, 0, 0, 1 / 60, [wall]);
    expect(camera.distance).toBeCloseTo(0, 6);
    expect(camera.pinched).toBe(false);
  });

  it('snaps onto the eye rather than damping in from wherever the camera was', () => {
    // The mode switch is a snap (`snapCamera`), and this is the reason it has to be: easing a
    // camera from three metres behind the head to inside it sweeps the view through the player's
    // own body, which reads as a glitch rather than as a transition.
    const { player, scratch, aim, camera } = makeRig(0, 0, 0, 'firstPerson');
    solveAim(aim, scratch, player, [], 'firstPerson');
    camera.position.x = 40;
    camera.position.y = 40;
    snapCamera(camera, aim, player);
    expect(camera.position.x).toBeCloseTo(aim.pivot.x, 9);
    expect(camera.position.y).toBeCloseTo(aim.pivot.y, 9);
    expect(camera.position.z).toBeCloseTo(aim.pivot.z, 9);
  });

  it('keeps the third-person numbers written once', () => {
    // `VIEW` repeats three of `CAMERA`'s values so both modes can be read from one table. Two
    // copies of a number that must agree is exactly the drift this project keeps catching, so the
    // copies are pinned to each other here.
    expect(VIEW.pivotRight.thirdPerson).toBe(CAMERA.pivotRight);
    expect(VIEW.pivotUp.thirdPerson).toBe(CAMERA.pivotUp);
    expect(VIEW.boomDistance.thirdPerson).toBe(CAMERA.hipDistance);
    expect(VIEW.adsBoomDistance.thirdPerson).toBe(CAMERA.adsDistance);
    expect(VIEW.adsPivotRight.thirdPerson).toBe(CAMERA.adsPivotRight);
    expect(VIEW.muzzleSide.thirdPerson).toBe(CAMERA.muzzleSide);
    expect(VIEW.muzzleDrop.thirdPerson).toBe(CAMERA.muzzleDrop);
    // And the first-person pivot is the eye, which is the definition of the mode.
    expect(VIEW.pivotUp.firstPerson).toBe(PLAYER.eyeHeight);
    expect(VIEW.boomDistance.firstPerson).toBe(0);
  });

  it('converges on the eye faster than the shoulder rig converges on its boom', () => {
    // Damping an eye is the "the world slides when I walk" defect, so the first-person rate has to
    // be the fast one. A number, not a feeling.
    expect(VIEW.firstPersonFollowRate).toBeGreaterThan(CAMERA.followRate);
  });
});

describe('ADS transition', () => {
  it('uses the config FOV at both ends of the transition', () => {
    const hip = makeRig(0, 0, 0);
    solveAim(hip.aim, hip.scratch, hip.player, []);
    expect(hip.aim.fovDeg).toBe(PLAYER.fovHip);

    const ads = makeRig(0, 0, 1);
    solveAim(ads.aim, ads.scratch, ads.player, []);
    expect(ads.aim.fovDeg).toBe(PLAYER.fovAds);
    // Aiming must narrow the view substantially, which is the mechanical point.
    expect(PLAYER.fovAds).toBeLessThan(PLAYER.fovHip);
  });

  it('reaches full ADS in exactly adsTime and returns to hip fire', () => {
    const state = createWeaponState(1);
    const dt = 1 / 60;
    let time = 0;
    let ticksToFull = 0;
    for (let i = 0; i < 200; i += 1) {
      tickWeapon(state, { fire: false, aim: true, reloadPressed: false }, dt, time);
      time += dt;
      ticksToFull += 1;
      if (state.adsProgress >= 1) break;
    }
    // Within one tick of the configured transition.
    expect(ticksToFull * dt).toBeGreaterThanOrEqual(PLAYER.adsTime);
    expect(ticksToFull * dt).toBeLessThan(PLAYER.adsTime + dt * 1.5);

    for (let i = 0; i < 200; i += 1) {
      tickWeapon(state, { fire: false, aim: false, reloadPressed: false }, dt, time);
      time += dt;
      if (state.adsProgress <= 0) break;
    }
    expect(state.adsProgress).toBe(0);
    expect(state.aiming).toBe(false);
  });

  it('collapses the shoulder offset while aiming but never crosses the body', () => {
    expect(CAMERA.adsPivotRight).toBeLessThan(CAMERA.pivotRight);
    expect(CAMERA.adsPivotRight).toBeGreaterThan(0);
  });
});

describe('crosshair convergence', () => {
  it('maps zero spread to a zero-radius crosshair', () => {
    expect(spreadToScreenRadius(0, PLAYER.fovHip, 900)).toBe(0);
  });

  it('grows with the cone and shrinks as the view narrows', () => {
    const wide = spreadToScreenRadius(WEAPON.spreadHipDeg, PLAYER.fovHip, 900);
    const wider = spreadToScreenRadius(WEAPON.spreadHipDeg * 2, PLAYER.fovHip, 900);
    const zoomed = spreadToScreenRadius(WEAPON.spreadHipDeg, PLAYER.fovAds, 900);
    expect(wide).toBeGreaterThan(0);
    expect(wider).toBeGreaterThan(wide);
    // Same cone, narrower FOV: the cone covers more of the screen, so the drawn
    // radius must grow 闁?this is what makes the crosshair track the zoom.
    expect(zoomed).toBeGreaterThan(wide);
  });

  it('scales linearly with viewport height', () => {
    const at900 = spreadToScreenRadius(1.5, PLAYER.fovHip, 900);
    const at1800 = spreadToScreenRadius(1.5, PLAYER.fovHip, 1800);
    expect(at1800).toBeCloseTo(at900 * 2, 9);
  });

  it('is a small-angle projection, so a 1閹?cone is a sane pixel radius', () => {
    // At 78閹?vertical FOV over 900 px, 1閹?should be about 1/39 of the view height.
    const radius = spreadToScreenRadius(1, PLAYER.fovHip, 900);
    const expected = (Math.tan(DEG2RAD) / Math.tan(PLAYER.fovHip * 0.5 * DEG2RAD)) * 450;
    expect(radius).toBeCloseTo(expected, 9);
    expect(radius).toBeGreaterThan(5);
    expect(radius).toBeLessThan(40);
  });
});

describe('camera collision', () => {
  it('shortens the boom when a crate is behind the player', () => {
    const { player, scratch, aim } = makeRig(0, 0);
    // A wall directly behind (camera at pivot + Z * 3.2).
    solveAim(aim, scratch, player, []);
    const blocked = aabb(aim.pivot.x, aim.pivot.y, aim.pivot.z + 2.0, 3, 3, 0.5);
    solveAim(aim, scratch, player, [blocked]);
    const distance = Math.hypot(
      aim.desiredPosition.x - aim.pivot.x,
      aim.desiredPosition.y - aim.pivot.y,
      aim.desiredPosition.z - aim.pivot.z,
    );
    expect(distance).toBeLessThan(CAMERA.hipDistance);
    // And it must never collapse all the way onto the pivot.
    expect(distance).toBeGreaterThanOrEqual(CAMERA.minDistance - 1e-9);
  });

  it('leaves the boom alone when nothing is behind', () => {
    const { player, scratch, aim } = makeRig(0, 0);
    solveAim(aim, scratch, player, []);
    const blocked = aabb(aim.pivot.x, aim.pivot.y, aim.pivot.z - 8, 3, 3, 0.5);
    solveAim(aim, scratch, player, [blocked]);
    const distance = Math.hypot(
      aim.desiredPosition.x - aim.pivot.x,
      aim.desiredPosition.y - aim.pivot.y,
      aim.desiredPosition.z - aim.pivot.z,
    );
    expect(distance).toBeCloseTo(CAMERA.hipDistance, 9);
  });
});

describe('camera pose', () => {
  it('adds recoil to the view without touching the authoritative player angles', () => {
    const { player, camera, scratch, aim } = makeRig(0.4, 0.1);
    solveAim(aim, scratch, player, []);
    updateCamera(camera, player, aim, 2, 0.5, 1 / 60, []);
    // The camera carries the offset...
    expect(camera.pitch).toBeCloseTo(player.pitch + 2 * DEG2RAD, 9);
    expect(camera.yaw).toBeCloseTo(player.yaw + 0.5 * DEG2RAD, 9);
    // ...and the player's aim is untouched, so the shot goes where they aimed.
    expect(player.pitch).toBe(0.1);
    expect(player.yaw).toBe(0.4);
  });

  it('clamps the resulting pitch to the configured limit', () => {
    const { player, camera, scratch, aim } = makeRig(0, 1.4);
    solveAim(aim, scratch, player, []);
    updateCamera(camera, player, aim, 45, 0, 1 / 60, []);
    expect(camera.pitch).toBeLessThanOrEqual(PLAYER.pitchClampDeg * DEG2RAD + 1e-9);
  });

  it('damps the camera toward the ideal position and stays finite', () => {
    const { player, scratch, aim, camera } = makeRig(0, 0);
    solveAim(aim, scratch, player, []);
    // Start the camera somewhere absurd, then converge over a second.
    camera.position.x = 500;
    camera.position.y = -500;
    camera.position.z = 500;
    for (let i = 0; i < 60; i += 1) {
      solveAim(aim, scratch, player, []);
      updateCamera(camera, player, aim, 0, 0, 1 / 60, []);
    }
    expect(Number.isFinite(camera.position.x)).toBe(true);
    expect(Number.isFinite(camera.position.y)).toBe(true);
    expect(camera.position.z).toBeCloseTo(aim.desiredPosition.z, 0);
    expect(camera.position.x).toBeCloseTo(aim.desiredPosition.x, 0);
  });
});

describe('player controller on the real level', () => {
  const level = buildLevel(11);
  const collision = createCollisionWorld(level);
  const rng = createRng(3);

  function stepPlayer(ticks: number, intent: Partial<import('#/core/input').InputIntent> = {}) {
    const weapon = createWeaponState(1);
    const player = createPlayerState(weapon);
    const scratch = createMovementScratch();
    const full = {
      move: { forward: 0, right: 0 },
      sprint: false,
      jump: false,
      fire: false,
      aim: false,
      reload: false,
      throwItem: false,
      interact: false,
      toggleView: false,
      lookDeltaX: 0,
      lookDeltaY: 0,
      ...intent,
    };
    let time = 0;
    for (let i = 0; i < ticks; i += 1) {
      tickPlayer(player, scratch, collision, full, 1 / 60, time);
      time += 1 / 60;
    }
    return player;
  }

  it('never leaves the arena footprint', () => {
    for (let trial = 0; trial < 12; trial += 1) {
      const yaw = rng.range(-Math.PI, Math.PI);
      // Drive hard for five seconds in a random direction, sprinting.
      const player = stepPlayer(300, {
        move: { forward: 1, right: 0 },
        sprint: true,
        lookDeltaX: -yaw / PLAYER.lookSensitivity,
      });
      expect(Math.abs(player.position.x)).toBeLessThanOrEqual(level.halfSize);
      expect(Math.abs(player.position.z)).toBeLessThanOrEqual(level.halfSize);
      expect(Number.isFinite(player.position.y)).toBe(true);
    }
  });

  it('never sinks below the floor or floats without support', () => {
    const player = stepPlayer(600, { move: { forward: 1, right: 0 }, sprint: true });
    expect(player.position.y).toBeGreaterThanOrEqual(-1e-6);
    expect(player.grounded).toBe(true);
    expect(player.position.y).toBeLessThan(level.halfSize);
  });

  it('accelerates to the configured walk speed and stops when released', () => {
    const moving = stepPlayer(120, { move: { forward: 1, right: 0 } });
    expect(moving.horizontalSpeed).toBeGreaterThan(PLAYER.walkSpeed * 0.95);
    expect(moving.horizontalSpeed).toBeLessThanOrEqual(PLAYER.walkSpeed + 1e-3);

    // Then release: decelerationTime is short, so one second is plenty.
    const weapon = createWeaponState(1);
    const player = createPlayerState(weapon);
    const scratch = createMovementScratch();
    const idle = {
      move: { forward: 1, right: 0 },
      sprint: false,
      jump: false,
      fire: false,
      aim: false,
      reload: false,
      throwItem: false,
      interact: false,
      toggleView: false,
      lookDeltaX: 0,
      lookDeltaY: 0,
    };
    let time = 0;
    for (let i = 0; i < 120; i += 1) {
      tickPlayer(player, scratch, collision, idle, 1 / 60, time);
      time += 1 / 60;
    }
    const released = { ...idle, move: { forward: 0, right: 0 } };
    for (let i = 0; i < 60; i += 1) {
      tickPlayer(player, scratch, collision, released, 1 / 60, time);
      time += 1 / 60;
    }
    expect(player.horizontalSpeed).toBeLessThan(0.05);
  });

  it('does not let a diagonal move beat a straight one', () => {
    const straight = stepPlayer(120, { move: { forward: 1, right: 0 } });
    const diagonal = stepPlayer(120, { move: { forward: 1, right: 1 } });
    expect(diagonal.horizontalSpeed).toBeCloseTo(straight.horizontalSpeed, 2);
  });

  it('keeps movement horizontal regardless of pitch', () => {
    // Pitch is not part of the movement basis: looking straight down must not
    // drive the player into the floor or change their speed.
    const weapon = createWeaponState(1);
    const player = createPlayerState(weapon);
    const scratch = createMovementScratch();
    player.pitch = -1.4;
    const intent = {
      move: { forward: 1, right: 0 },
      sprint: false,
      jump: false,
      fire: false,
      aim: false,
      reload: false,
      throwItem: false,
      interact: false,
      toggleView: false,
      lookDeltaX: 0,
      lookDeltaY: 0,
    };
    let time = 0;
    for (let i = 0; i < 120; i += 1) {
      tickPlayer(player, scratch, collision, intent, 1 / 60, time);
      time += 1 / 60;
    }
    expect(player.velocity.y).toBeCloseTo(0, 6);
    expect(player.position.y).toBeCloseTo(0, 6);
    expect(player.horizontalSpeed).toBeGreaterThan(PLAYER.walkSpeed * 0.95);
  });

  it('clamps pitch to the configured limit', () => {
    const weapon = createWeaponState(1);
    const player = createPlayerState(weapon);
    const scratch = createMovementScratch();
    const intent = {
      move: { forward: 0, right: 0 },
      sprint: false,
      jump: false,
      fire: false,
      aim: false,
      reload: false,
      throwItem: false,
      interact: false,
      toggleView: false,
      // A giant upward drag in one tick.
      lookDeltaX: 0,
      lookDeltaY: -100_000,
    };
    tickPlayer(player, scratch, collision, intent, 1 / 60, 0);
    expect(player.pitch).toBeLessThanOrEqual(PLAYER.pitchClampDeg * DEG2RAD + 1e-9);
    expect(player.pitch).toBeGreaterThan(0);
  });

  it('walks north from spawn and is stopped only by real cover', () => {
    // Walking straight forward from spawn crosses open ground and then meets the
    // central crate cluster. What matters here is that the controller keeps the
    // player on the floor and inside the arena the whole way - being halted by a
    // 1.2 m crate is correct behaviour, not a failure.
    const player = stepPlayer(300, { move: { forward: 1, right: 0 } });
    expect(player.position.z).toBeLessThan(0);
    expect(player.grounded).toBe(true);
    expect(player.position.y).toBeCloseTo(0, 6);
  });

  it('reads its obstacles from the one authored list, minus the floor', () => {
    // `createCollisionWorld` used to re-derive its own obstacle list from `props`. That was
    // equal to `collisionBoxes` right up until the decorative pieces became solid 鈥?at which
    // point only one of the two derivations would have known about them, and the player
    // would have kept walking through lamp posts with the collision list insisting otherwise.
    expect(collision.obstacles.length).toBe(level.collisionBoxes.length - 1);
    expect(collision.solids).toBe(level.blockers);
  });

  it('is stopped by a decorative piece, not only by cover', () => {
    // Until phase 6 the lamp ring, the masts, the crate stacks and the pipe runs were
    // looked-at-only: the player walked straight through them, which is exactly what a
    // player reports as "the obstacles have no collision".
    const lamp = level.decor.find(
      (piece) => piece.kind === 'lamp' && Math.abs(piece.position.x) < 1e-9 && piece.position.z < -19,
    );
    expect(lamp).toBeDefined();
    const post = decorCollisionBoxes(lamp!)[0]!;

    const player = createPlayerState(createWeaponState(1));
    // Three metres south of the post, facing north: straight at it, nothing in between.
    player.position.x = post.center.x;
    player.position.z = post.center.z + 3;
    const scratch = createMovementScratch();
    const intent = {
      move: { forward: 1, right: 0 },
      sprint: false,
      jump: false,
      fire: false,
      aim: false,
      reload: false,
      throwItem: false,
      interact: false,
      toggleView: false,
      lookDeltaX: 0,
      lookDeltaY: 0,
    };
    let time = 0;
    for (let i = 0; i < 180; i += 1) {
      tickPlayer(player, scratch, collision, intent, 1 / 60, time);
      time += 1 / 60;
    }

    // Stopped against the post's near face, on the spawn side of it: the capsule's radius is
    // as much of a 0.24 m post as a 0.35 m capsule can get through, and it got through none.
    expect(player.position.z).toBeGreaterThan(post.center.z);
    expect(player.position.z).toBeCloseTo(post.center.z + post.halfExtents.z + PLAYER.radius, 1);
  });

  it('walks up a low curb instead of being blocked by it', () => {
    const weapon = createWeaponState(1);
    const player = createPlayerState(weapon);
    const scratch = createMovementScratch();
    // A 0.3 m step directly in front, comfortably below the 0.45 m step height.
    const stepWorld = {
      obstacles: [aabb(0, 0.15, 4, 3, 0.15, 1)],
      solids: [],
      halfSize: 24,
    };
    const intent = {
      move: { forward: 1, right: 0 },
      sprint: false,
      jump: false,
      fire: false,
      aim: false,
      reload: false,
      throwItem: false,
      interact: false,
      toggleView: false,
      lookDeltaX: 0,
      lookDeltaY: 0,
    };
    player.position.z = 8;
    let time = 0;
    for (let i = 0; i < 240; i += 1) {
      tickPlayer(player, scratch, stepWorld, intent, 1 / 60, time);
      time += 1 / 60;
      // The capsule must never drop back to the floor once it is up: that
      // oscillation (climb, fall, climb) is the failure mode this guards.
      if (player.position.z < 4.9 && player.position.z > 3.1) {
        expect(player.position.y, `tick ${i}`).toBeCloseTo(0.3, 6);
      }
    }
    // It climbed onto the step, crossed it, and walked off the far side.
    expect(player.position.z).toBeLessThan(3);
  });

  it('does not climb a crate that is taller than the step height', () => {
    const weapon = createWeaponState(1);
    const player = createPlayerState(weapon);
    const scratch = createMovementScratch();
    // 1.2 m tall: the central crate cluster's height, which must stay cover.
    const crateWorld = { obstacles: [aabb(0, 0.6, 4, 3, 0.6, 1)], solids: [], halfSize: 24 };
    const intent = {
      move: { forward: 1, right: 0 },
      sprint: false,
      jump: false,
      fire: false,
      aim: false,
      reload: false,
      throwItem: false,
      interact: false,
      toggleView: false,
      lookDeltaX: 0,
      lookDeltaY: 0,
    };
    player.position.z = 8;
    let time = 0;
    for (let i = 0; i < 240; i += 1) {
      tickPlayer(player, scratch, crateWorld, intent, 1 / 60, time);
      time += 1 / 60;
    }
    // Stopped at the face, still on the floor.
    expect(player.position.z).toBeGreaterThan(4.9);
    expect(player.position.y).toBeCloseTo(0, 6);
  });

  it('slides along a wall rather than stopping dead', () => {
    const weapon = createWeaponState(1);
    const player = createPlayerState(weapon);
    const scratch = createMovementScratch();
    // A long wall along X at z = 0; the player runs into it at 45閹?
    const wallWorld = {
      obstacles: [aabb(0, 1, 0, 12, 1, 0.5)],
      solids: [],
      halfSize: 24,
    };
    const intent = {
      move: { forward: 1, right: 1 },
      sprint: false,
      jump: false,
      fire: false,
      aim: false,
      reload: false,
      throwItem: false,
      interact: false,
      toggleView: false,
      lookDeltaX: 0,
      lookDeltaY: 0,
    };
    player.position.z = 6;
    player.position.x = 0;
    let time = 0;
    for (let i = 0; i < 180; i += 1) {
      tickPlayer(player, scratch, wallWorld, intent, 1 / 60, time);
      time += 1 / 60;
    }
    // It cannot pass through, but it must keep making lateral progress.
    expect(player.position.z).toBeGreaterThan(0.5 - 1e-6);
    expect(Math.abs(player.position.x)).toBeGreaterThan(3);
  });
});

/**
 * The double jump.
 *
 * The controller tests above drive a whole run; this block needs the opposite 鈥?one tick at a
 * time, because the feature is entirely about *when* the key goes down. Every assertion here
 * is a rule the player can feel: the second jump exists, holding the key does not spend it,
 * there is no third one, and walking off a ledge costs the takeoff jump rather than granting
 * a free extra one.
 */
describe('double jump', () => {
  const level = buildLevel(11);
  const collision = createCollisionWorld(level);

  /**
   * Runs a jump script: `held(i)` says whether Space is down on tick `i`.
   *
   * Returns the highest the feet got, which is the only thing a player can observe about a
   * jump, plus the player state for the bookkeeping assertions.
   */
  function jump(held: (tick: number) => boolean, options: { ticks?: number; dt?: number } = {}) {
    const dt = options.dt ?? 1 / 60;
    const ticks = options.ticks ?? Math.round(2 / dt);
    const player = createPlayerState(createWeaponState(1));
    const scratch = createMovementScratch();
    let time = 0;
    let peak = player.position.y;
    /** The high-water mark of the jump counter, which is what "how many jumps did it allow"
     *  actually asks: by the end of a two-second run the player has landed and it reads 0. */
    let maxJumpsUsed = 0;
    for (let i = 0; i < ticks; i += 1) {
      tickPlayer(
        player,
        scratch,
        collision,
        {
          move: { forward: 0, right: 0 },
          sprint: false,
          jump: held(i),
          fire: false,
          aim: false,
          reload: false,
          throwItem: false,
          interact: false,
          toggleView: false,
          lookDeltaX: 0,
          lookDeltaY: 0,
        },
        dt,
        time,
      );
      time += dt;
      peak = Math.max(peak, player.position.y);
      maxJumpsUsed = Math.max(maxJumpsUsed, player.jumpsUsed);
    }
    return { player, peak, maxJumpsUsed };
  }

  /** Press on the given ticks and nowhere else. */
  const pressOn = (...ticks: number[]) => (i: number): boolean => ticks.includes(i);

  it('gets higher with a second jump than with one', () => {
    // One jump from the ground: the apex is v虏/2g = 7.2虏 / 44 鈮?1.18 m.
    const single = jump(pressOn(0));
    expect(single.peak).toBeGreaterThan(1);
    expect(single.peak).toBeLessThan(1.4);
    expect(single.player.grounded).toBe(true);

    // The second press lands at the apex of the first (v/g 鈮?0.33 s 鈮?20 ticks), which is
    // where it buys the most height.
    const double = jump(pressOn(0, 20));
    expect(double.peak).toBeGreaterThan(single.peak * 1.5);
    // Two full impulses, so roughly twice the height of one.
    expect(double.peak).toBeCloseTo(single.peak * 2, 1);
  });

  it('does not spend the air jump while the key is held down', () => {
    // Holding Space from the floor is one jump and stays one jump. A level-triggered air
    // jump would fire on the tick after the takeoff and leave the player with a stunted hop.
    // (The key being held means the ground jump re-fires on every landing, which is the
    // behaviour it has always had 鈥?the counter is what must not climb past one.)
    const held = jump(() => true);
    expect(held.maxJumpsUsed).toBe(1);
    expect(held.peak).toBeLessThan(1.4);
  });

  it('never allows a third jump', () => {
    const double = jump(pressOn(0, 20));
    const triple = jump(pressOn(0, 20, 40));
    expect(triple.maxJumpsUsed).toBe(PLAYER.maxJumps);
    expect(triple.peak).toBeCloseTo(double.peak, 5);
  });

  it('starts the count at one when the player leaves the ground without jumping', () => {
    // Dropped from three metres: gravity takes over, so the takeoff jump is spent and only
    // one air jump is left. "Two jumps" means two, not "one plus every fall".
    const player = createPlayerState(createWeaponState(1));
    const scratch = createMovementScratch();
    const intent = (jumpHeld: boolean) => ({
      move: { forward: 0, right: 0 },
      sprint: false,
      jump: jumpHeld,
      fire: false,
      aim: false,
      reload: false,
      throwItem: false,
      interact: false,
      toggleView: false,
      lookDeltaX: 0,
      lookDeltaY: 0,
    });
    player.position.y = 3;
    player.grounded = true;
    let time = 0;
    for (let i = 0; i < 10; i += 1) {
      tickPlayer(player, scratch, collision, intent(false), 1 / 60, time);
      time += 1 / 60;
    }
    expect(player.grounded).toBe(false);
    expect(player.jumpsUsed).toBe(1);

    // One press works, the next one does not: the fall already cost the first jump.
    tickPlayer(player, scratch, collision, intent(true), 1 / 60, time);
    time += 1 / 60;
    expect(player.jumpsUsed).toBe(2);
    // The impulse minus the one tick of gravity that the same tick applies to it.
    expect(player.velocity.y).toBeCloseTo(PLAYER.jumpVelocity - PLAYER.gravity / 60, 6);
  });

  it('clears the count on landing', () => {
    const doubled = jump(pressOn(0, 20));
    expect(doubled.player.grounded).toBe(true);
    expect(doubled.player.jumpsUsed).toBe(0);
  });

  it('resets the count and the key history with the run', () => {
    const player = createPlayerState(createWeaponState(1));
    player.jumpsUsed = 2;
    player.jumpHeldLastTick = true;
    resetPlayerState(player);
    expect(player.jumpsUsed).toBe(0);
    expect(player.jumpHeldLastTick).toBe(false);
  });

  it('reaches the same height at 240 Hz as at 60 Hz', () => {
    // The whole rule lives in the simulation, so it must not care about the tick rate. The
    // same press pattern *in seconds* is ticks 0 and 20 at 60 Hz and ticks 0 and 79 at 240 Hz
    // (the apex of the first jump is v/g 鈮?0.33 s in).
    const slow = jump(pressOn(0, 20));
    const fast = jump(pressOn(0, 79), { dt: 1 / 240, ticks: 960 });
    // Not *identical*: the two press patterns are a third of a millisecond apart and the
    // integrator is explicit, so a few centimetres on a 2.3 m jump is the expected spread.
    expect(Math.abs(fast.peak - slow.peak)).toBeLessThan(0.15);
    expect(fast.maxJumpsUsed).toBe(PLAYER.maxJumps);
  });
});
