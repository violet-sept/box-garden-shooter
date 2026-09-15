/**
 * Applies the simulation's camera state to a `THREE.PerspectiveCamera`.
 *
 * The split is deliberate: `game/camera/camera.ts` decides *where the camera is
 * and where it points* in plain numbers (so it is testable), and this file does
 * the one thing that needs an engine — copy those numbers onto a `Object3D`.
 * There is no smoothing, no collision and no recoil model here; all of that has
 * already happened in the simulation layer.
 */

import { Euler, PerspectiveCamera, Vector3 } from 'three';
import { DEG2RAD } from '../../core/math/vec3';
import type { CameraState } from '../../game/camera/camera';

/** Rotation order the camera state's yaw/pitch/roll are expressed in. */
const ROTATION_ORDER = 'YXZ';

/** Reusable Euler so applying the pose allocates nothing per frame. */
const scratchEuler = new Euler(0, 0, 0, ROTATION_ORDER);
const scratchPosition = new Vector3();

/**
 * Copies a {@link CameraState} onto a `PerspectiveCamera`.
 *
 * FOV is written with a change check because assigning to `fov` alone does not
 * rebuild the projection matrix, and rebuilding it unconditionally every frame is
 * wasted work on the common case of a settled ADS transition.
 */
export function applyCameraState(camera: PerspectiveCamera, state: CameraState): void {
  scratchPosition.set(state.position.x, state.position.y, state.position.z);
  camera.position.copy(scratchPosition);

  // `YXZ` is the order the state was authored in: yaw about world Y, then pitch
  // about local X, then roll about local Z. Any other order tilts the horizon
  // when the player looks up, which reads as a broken camera rather than a bug.
  scratchEuler.set(state.pitch, state.yaw, state.roll, ROTATION_ORDER);
  camera.quaternion.setFromEuler(scratchEuler);

  if (Math.abs(camera.fov - state.fovDeg) > 1e-4) {
    camera.fov = state.fovDeg;
    camera.updateProjectionMatrix();
  }
}

/** The camera's forward vector as a `THREE.Vector3`, for effect placement. */
export function cameraForward(camera: PerspectiveCamera, out: Vector3): Vector3 {
  return out.set(0, 0, -1).applyQuaternion(camera.quaternion);
}

/** Converts a spread half-angle to a crosshair radius in CSS pixels. */
export function crosshairRadiusPx(spreadDeg: number, fovDeg: number, viewportHeight: number): number {
  const halfFov = fovDeg * 0.5 * DEG2RAD;
  if (halfFov <= 0 || halfFov >= Math.PI / 2) return 0;
  return (Math.tan(spreadDeg * DEG2RAD) / Math.tan(halfFov)) * (viewportHeight * 0.5);
}
