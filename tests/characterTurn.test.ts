/**
 * The player body's turn.
 *
 * Three properties are pinned here, and each of them is a way the turn can look wrong
 * rather than a way it can crash:
 *
 *   - **the target facing** — walking must win over looking, so a character strafing while
 *     the camera faces forward is not moonwalking sideways;
 *   - **the rate** — a 180° about-face takes a quarter of a second at the configured rate,
 *     and takes the *same* quarter of a second at 60 Hz and at 240 Hz;
 *   - **the direction** — the shortest way round, so a turn across the ±π wrap does not spin
 *     the long way and read as a glitch.
 *
 * Nothing here touches the simulation: the body's yaw is a picture, and the shot direction
 * comes from `player.yaw`. A test that had to build a world to check it would mean the
 * boundary had been crossed.
 */

import { describe, expect, it } from 'vitest';
import {
  createBodyPose,
  resetBodyPose,
  shortestAngleTo,
  stepBodyPose,
  targetBodyYaw,
} from '#/render/models/characterTurn';
import { PLAYER } from '#/core/config';
import { DEG2RAD } from '#/core/math/vec3';

/** Degrees of turn the rate limit allows in a second, for readable expectations. */
const TURN_RATE = PLAYER.turnRateDegPerSec;

describe('targetBodyYaw', () => {
  it('faces the direction of travel when the player is moving', () => {
    // The project's yaw zero faces -Z, so walking straight north (velocity -Z) is yaw 0.
    expect(targetBodyYaw(0, -5, 1.2)).toBeCloseTo(0, 12);
    // Walking -X is a quarter turn to the left, which is +90°.
    expect(targetBodyYaw(-5, 0, 1.2)).toBeCloseTo(Math.PI / 2, 12);
    // Walking +Z is a full about-face.
    expect(Math.abs(targetBodyYaw(0, 5, 1.2))).toBeCloseTo(Math.PI, 12);
  });

  it('faces the camera when the player is standing still', () => {
    // Looking around on the spot is the other half of the feature: the character pivots to
    // follow the view rather than standing frozen while the player spins the camera.
    expect(targetBodyYaw(0, 0, 0.9)).toBe(0.9);
    expect(targetBodyYaw(0.05, -0.05, 0.9)).toBe(0.9);
  });

  it('switches between the two exactly at the configured threshold', () => {
    expect(PLAYER.idleSpeedThreshold).toBeGreaterThan(0);
    expect(targetBodyYaw(0, -PLAYER.idleSpeedThreshold * 0.5, 0.9)).toBe(0.9);
    expect(targetBodyYaw(0, -PLAYER.idleSpeedThreshold, 0.9)).toBeCloseTo(0, 12);
  });
});

describe('shortestAngleTo', () => {
  it('takes the short way round the wrap', () => {
    // +3 rad to -3 rad is a fifth of a radian *forward*, not 2π backwards: getting this
    // wrong makes the character pirouette instead of turning.
    expect(shortestAngleTo(3, -3)).toBeCloseTo(-3 - 3 + Math.PI * 2, 12);
    expect(Math.abs(shortestAngleTo(3, -3))).toBeLessThan(Math.PI);
    expect(shortestAngleTo(0, 0.4)).toBeCloseTo(0.4, 12);
  });
});

describe('stepBodyPose', () => {
  it('turns at the configured rate and no faster', () => {
    const pose = createBodyPose(0);
    // A 180° about-face, one 60 Hz frame at a time.
    for (let i = 0; i < 14; i += 1) stepBodyPose(pose, Math.PI, 1 / 60);
    const expected = 14 * TURN_RATE * DEG2RAD * (1 / 60);
    expect(pose.yaw).toBeCloseTo(expected, 9);
    expect(pose.error).toBeGreaterThan(0);
  });

  it('finishes the same 180° in a quarter of a second at 60 Hz and at 240 Hz', () => {
    // A rate limit, not damping: the turn is a speed, so the display's refresh rate cannot
    // change how long it takes or how far it goes.
    const slow = createBodyPose(0);
    for (let i = 0; i < 15; i += 1) stepBodyPose(slow, Math.PI, 1 / 60);
    const fast = createBodyPose(0);
    for (let i = 0; i < 60; i += 1) stepBodyPose(fast, Math.PI, 1 / 240);

    expect(slow.yaw).toBeCloseTo(Math.PI, 9);
    expect(fast.yaw).toBeCloseTo(Math.PI, 9);
    expect(slow.error).toBeCloseTo(0, 9);
    expect(fast.error).toBeCloseTo(0, 9);
  });

  it('lands exactly on the target instead of creeping up on it', () => {
    const pose = createBodyPose(0);
    const target = 0.1;
    // One frame's allowance (12° at 60 Hz) covers a 5.7° turn outright.
    stepBodyPose(pose, target, 1 / 60);
    expect(pose.yaw).toBeCloseTo(target, 12);
    expect(pose.error).toBeCloseTo(0, 12);
  });

  it('rolls into the turn and never past the configured cap', () => {
    const pose = createBodyPose(0);
    const maxBank = PLAYER.bodyTurnBankMaxDeg * DEG2RAD;
    // A target that keeps running away, so the body is always mid-turn.
    for (let i = 0; i < 60; i += 1) stepBodyPose(pose, pose.yaw + 3, 1 / 60);

    // Turning to the left (+error) leans the body to its own left, which is a negative roll.
    expect(pose.bank).toBeLessThan(0);
    expect(Math.abs(pose.bank)).toBeLessThanOrEqual(maxBank);
    expect(Math.abs(pose.bank)).toBeGreaterThan(maxBank * 0.9);
  });

  it('settles the lean back to zero once it is facing the target', () => {
    const pose = createBodyPose(0);
    stepBodyPose(pose, 2.5, 1 / 60);
    expect(Math.abs(pose.bank)).toBeGreaterThan(0);
    for (let i = 0; i < 120; i += 1) stepBodyPose(pose, 2.5, 1 / 60);

    expect(pose.yaw).toBeCloseTo(2.5, 9);
    expect(pose.bank).toBeCloseTo(0, 6);
  });

  it('stays finite on a zero-length frame', () => {
    // `dt = 0` happens on the frame a paused tab is restored. Dividing by it is the obvious
    // way to turn "the lean is proportional to angular velocity" into a NaN model.
    const pose = createBodyPose(0.4);
    stepBodyPose(pose, 1.4, 0);
    expect(Number.isFinite(pose.yaw)).toBe(true);
    expect(Number.isFinite(pose.bank)).toBe(true);
    expect(pose.yaw).toBe(0.4);
  });
});

describe('resetBodyPose', () => {
  it('snaps to a facing and clears the lean', () => {
    const pose = createBodyPose(0);
    stepBodyPose(pose, 3, 1 / 60);
    resetBodyPose(pose, -2);

    expect(pose.yaw).toBeCloseTo(-2, 12);
    expect(pose.bank).toBe(0);
    expect(pose.error).toBe(0);
  });
});
