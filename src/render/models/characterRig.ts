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
 *
 * ## View mode (phase 8)
 *
 * The rig also owns what is *drawn* of the player, which is the one thing a view mode changes on
 * the render side: in first person the body is hidden (the camera is inside its head, so the only
 * thing a drawn body can contribute is the inside of a capsule across the screen) and the rifle is
 * re-parented to the camera with a viewmodel pose. Both are decided here rather than in `main.ts`
 * for the same reason as everything else in this file: they are presentation rules with a
 * right answer, and `tests/views.test.ts` can assert them.
 */

import type { Object3D } from 'three';
import type { CharacterModel, CharacterState } from './CharacterLoader';
import { createBodyPose, resetBodyPose, stepBodyPose, targetBodyYaw, type BodyPose } from './characterTurn';
import { createPlayerWeapon, type PlayerWeapon } from './playerWeapon';
import { PLAYER, VIEW, WEAPON_MODEL } from '../../core/config';
import { DEG2RAD } from '../../core/math/vec3';
import type { ViewMode } from '../../game/camera/camera';
import type { PlayerState } from '../../game/player/player';

/** What the rig exposes for the composition root and for tests. */
export interface CharacterRig {
  readonly model: CharacterModel;
  /**
   * The rifle in the body's hands.
   *
   * Owned by the rig because it rides the player: it is added to the model's root in third person
   * and to the camera in first, so wherever the player is placed and whichever way they face, the
   * weapon follows with no second write per frame. Its placement is `WEAPON_MODEL.anchor` in the
   * body's own frame, or `VIEW.firstPersonWeapon` in the camera's.
   */
  readonly weapon: PlayerWeapon;
  /**
   * Places, turns and animates the body, and applies the view mode's draw rules.
   *
   * `dt` is render time, in seconds. `mode` comes from `World.camera.viewMode` — the one
   * authority on which view the run is in — and defaults to third person, which is *not* the
   * game's default view but is the right default **here**: a body handed to this function with no
   * further instruction is the phase-1-through-7 rig, drawn with the rifle in its hands.
   *
   * `camera` is required in first person and only then: it is the viewmodel's parent, and there is
   * no way to draw a gun in front of an eye without knowing where the eye is. Requiring it in
   * third person too would mean every caller and every test carries a value only one branch reads.
   */
  sync(player: PlayerState, dt: number, mode?: ViewMode, camera?: Object3D): void;
  /** Snaps to a facing, clears the lean and puts a dead body back on its feet. */
  reset(yaw: number): void;
  /** The body's own yaw, in radians. Not the player's. */
  readonly yaw: number;
  /** The lean into the current pivot, in radians. */
  readonly bank: number;
  /** The state last handed to `play`, which the death hold may have refused. */
  readonly state: CharacterState | null;
  /** The view mode the rig is currently drawing for. */
  readonly viewMode: ViewMode | null;
  /** True while the body itself is drawn. False in first person. */
  readonly bodyVisible: boolean;
  /** Releases the weapon's geometry. The model is the caller's to dispose. */
  dispose(): void;
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
  /** Which mode the frame currently drawn was set up for. `null` until the first `sync`. */
  let drawing: ViewMode | null = null;

  /**
   * The rifle.
   *
   * It **moves between two parents** rather than existing twice: in third person it is a child of
   * the body's root (one write, and it follows the body's position, facing and lean for as long as
   * that lasts) and in first person it is a child of the camera in a viewmodel pose. One rifle
   * means "which gun is the real one" cannot become two answers.
   */
  const weapon = createPlayerWeapon();

  /** Parents the rifle to the body, at the body-frame anchor. */
  function applyBodyWeapon(): void {
    model.root.add(weapon.root);
    weapon.root.position.set(WEAPON_MODEL.anchor.x, WEAPON_MODEL.anchor.y, WEAPON_MODEL.anchor.z);
    weapon.root.rotation.set(WEAPON_MODEL.pitchDeg * DEG2RAD, 0, 0);
  }

  /**
   * Parents the rifle to the camera, in the viewmodel pose.
   *
   * The offsets are the camera's own frame (`-z` forward, `+x` right), which is why they are small
   * metre values rather than body-frame coordinates. `ads` slides it forward along the aim axis
   * toward the sights and does nothing else: the camera already collapses its pivot and narrows
   * its FOV, so a separately tuned "raise the gun" animation would fight that.
   *
   * `add` is idempotent for an object that is already a child, so this is called every
   * first-person frame rather than only on a mode change — one code path, so a pose can never be
   * left over from the mode before.
   */
  function applyCameraWeapon(camera: Object3D | undefined, ads: number): void {
    if (!camera) {
      // A wiring error rather than a runtime condition: first person without a camera means the
      // gun would be drawn nowhere, silently. Naming the mistake here is the difference between a
      // five-second fix and a screenshot of an empty screen.
      throw new Error('characterRig.sync: first person needs the camera to hang the viewmodel on.');
    }
    camera.add(weapon.root);
    weapon.root.position.set(
      VIEW.firstPersonWeapon.x,
      VIEW.firstPersonWeapon.y,
      VIEW.firstPersonWeapon.z - VIEW.firstPersonWeaponAdsForward * ads,
    );
    weapon.root.rotation.set(
      VIEW.firstPersonWeapon.pitchDeg * DEG2RAD,
      VIEW.firstPersonWeapon.yawDeg * DEG2RAD,
      0,
    );
  }

  applyBodyWeapon();

  return {
    model,
    weapon,

    sync(player, dt, mode = 'thirdPerson', camera) {
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

      // --- View mode: what is drawn, and where the gun hangs ------------------
      // `model.root.visible` flips only on a change, but the two weapon writers below run every
      // frame: they are idempotent, and running them unconditionally is what stops a pose from one
      // mode being left in place in the other.
      if (mode !== drawing) {
        model.root.visible = mode === 'thirdPerson';
        drawing = mode;
      }
      if (mode === 'thirdPerson') {
        model.root.add(weapon.root);
        applyBodyWeapon();
      } else {
        applyCameraWeapon(camera, player.weapon.adsProgress);
      }

      // Animation keeps advancing in first person even though none of the body is drawn.
      // Freezing it would make the return to third person snap to a pose that had been held for
      // however long the player spent in first person, and the mixer costs the same either way.
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
      // A restart also resets the world to `CAMERA.defaultView`, so the cached mode has to be
      // dropped: keeping it would leave `mode === drawing` true and the body undrawn for the
      // first frames of a run that starts in third person.
      drawing = null;
      model.root.visible = true;
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
    get viewMode() {
      return drawing;
    },
    get bodyVisible() {
      return model.root.visible;
    },

    dispose() {
      // Only the weapon: the loaded model (or the placeholder) is handed in, so it stays the
      // caller's to release. Taking it here would make the rig own something it did not build.
      // `removeFromParent` because the mode decides which parent it is currently under.
      weapon.root.removeFromParent();
      weapon.dispose();
    },
  };
}
