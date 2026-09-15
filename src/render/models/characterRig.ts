/**
 * The player's body, as one object the composition root can drive.
 *
 * ## Why this is a module and not four lines in `main.ts`
 *
 * It was four lines in `main.ts`: set the position, set `rotation.y` from the player's yaw,
 * pick a clip, advance the mixer. Every one of those decisions is a presentation decision
 * with a rule attached (which way the body faces, how fast it may turn, when a clip change
 * is worth a crossfade), and none of them could be tested while they lived inside a
 * function that needs a `<canvas>`, a `WebGLRenderer` and a live `World` to run at all.
 *
 * The project has now paid for that twice: `attach.ts` had a bound method that was not
 * bound, and `InputState` had an `update()` the composition root never called. Both were
 * invisible to a green test suite for exactly the same reason — the only code that could
 * have caught them was code no test could reach. A body rig is cheap to reach: hand it a
 * model and a player state and it answers.
 *
 * ## What it decides, and what it must never decide
 *
 * It answers "where is the body, which way is it facing, and which clip is playing". It does
 * **not** answer where the player is, where the shot goes, or what the camera sees: those
 * are the simulation's and are handed in. The body's yaw in particular is a picture — see
 * `characterTurn.ts` for why a lagging body cannot cost the player a shot.
 */

import type { CharacterModel, CharacterState } from './CharacterLoader';
import { createBodyPose, resetBodyPose, stepBodyPose, targetBodyYaw, type BodyPose } from './characterTurn';
import { PLAYER } from '../../core/config';
import type { PlayerState } from '../../game/player/player';

/** What the rig exposes for the composition root and for tests. */
export interface CharacterRig {
  readonly model: CharacterModel;
  /** Places, turns and animates the body. `dt` is render time, in seconds. */
  sync(player: PlayerState, dt: number): void;
  /** Snaps to a facing, clears the lean and puts a dead body back on its feet. */
  reset(yaw: number): void;
  /** The body's own yaw, in radians. Not the player's. */
  readonly yaw: number;
  /** The lean into the current pivot, in radians. */
  readonly bank: number;
  /** The state last handed to `play`, which the death hold may have refused. */
  readonly state: CharacterState | null;
}

/**
 * Which animation state the body should be in.
 *
 * Chosen from the simulation's own velocity rather than from the input intent: a player
 * pressed against a crate is holding `W` and not moving, and "running on the spot against a
 * wall" is the classic tell that the renderer was asked about the keyboard instead of about
 * the world.
 */
export function characterStateFor(player: PlayerState): CharacterState {
  if (player.dead) return 'death';
  if (player.weapon.mode === 'reloading') return 'reload';
  const speed = Math.hypot(player.velocity.x, player.velocity.z);
  if (speed < PLAYER.idleSpeedThreshold) return 'idle';
  return speed > PLAYER.walkSpeed * 1.05 ? 'run' : 'walk';
}

/** Creates the rig around an already-loaded model. */
export function createCharacterRig(model: CharacterModel): CharacterRig {
  const pose: BodyPose = createBodyPose();
  let played: CharacterState | null = null;
  /**
   * Whether the first frame has been placed.
   *
   * The model loads asynchronously, so the first `sync` can arrive long after boot. Without
   * this, the pose would start at yaw 0 and *pivot* to wherever the player is already
   * looking — a slow turn with nothing to justify it, on the first frame the body appears.
   */
  let placed = false;

  return {
    model,

    sync(player, dt) {
      if (!placed) {
        resetBodyPose(pose, player.yaw);
        placed = true;
      }
      model.root.position.set(player.position.x, player.position.y, player.position.z);

      stepBodyPose(pose, targetBodyYaw(player.velocity.x, player.velocity.z, player.yaw), dt);
      // `+ PI` because the character model's brief specifies that it faces `+Z` while the
      // simulation's yaw zero points down `-Z`. Getting this wrong is the "the character
      // moonwalks everywhere" bug, and it is invisible in a screenshot of a standing player.
      model.root.rotation.y = pose.yaw + Math.PI;
      // The lean into the pivot, in the body's own frame (the root's Euler order is `YXZ`).
      model.root.rotation.z = pose.bank;

      const state = characterStateFor(player);
      if (state !== played) {
        model.play(state);
        played = state;
      }
      model.update(dt);
    },

    reset(yaw) {
      resetBodyPose(pose, yaw);
      // The model holds its death pose across a restart on purpose, so it has to be told the
      // run is over as well — otherwise the next run begins with a body on the floor.
      model.reset();
      played = null;
      placed = true;
    },

    get yaw() {
      return pose.yaw;
    },
    get bank() {
      return pose.bank;
    },
    get state() {
      return played;
    },
  };
}
