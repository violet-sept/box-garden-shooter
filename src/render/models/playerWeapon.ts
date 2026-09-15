/**
 * The rifle in the player's hands, built from primitives.
 *
 * ## Why procedural, and why in its own module
 *
 * The project owns no binary art — there is no `public/` — so the weapon follows the same
 * rule as the level, the enemies and the placeholder body: geometry assembled in code from
 * `BoxGeometry` / `CylinderGeometry` and a handful of shared materials (plan §1.7, decision
 * D14). Dropping in a `weapon.glb` later would be a change to this file alone.
 *
 * It is a module rather than a dozen lines inside `characterRig.ts` because the one thing
 * about it that can be *wrong* invisibly is which side of the body it hangs on. The model
 * faces `+Z` and the body's right hand is at `-x` (right = forward × up), and a sign error
 * there produces a rifle floating beside the wrong shoulder — perfectly plausible in a
 * screenshot, and impossible to catch by reading the code that sets `rotation.y = yaw + π`.
 * `tests/views.test.ts` therefore asserts the rifle's **world** position against the
 * player's own right-hand side, not its local offset.
 *
 * ## What it does not do
 *
 * It does not aim, recoil, bob or report a muzzle point. The shot's origin and direction are
 * the simulation's (`World.muzzlePosition` / `aimDirection`, derived from the camera rig's
 * own offset) and the tracer, the flash and the impact all come from there. Giving the rifle
 * a second opinion about where the muzzle is would be a second truth about the same
 * question — the exact failure mode this project keeps paying for.
 */

import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  type BufferGeometry,
} from 'three';
import { WEAPON_MODEL } from '../../core/config';
import { DEG2RAD } from '../../core/math/vec3';
import { LAYER_DEFAULT } from './CharacterLoader';

/** What the rig gets. */
export interface PlayerWeapon {
  /** Add this to the character's root; it is positioned in the body's own frame. */
  readonly root: Group;
  /** Distance from the rear of the stock to the muzzle tip, in metres. */
  readonly length: number;
  dispose(): void;
}

/**
 * Builds the rifle, with its grip at the group's origin and the barrel along `+z`.
 *
 * Everything hangs off the configured numbers: the local `+z` is the model's forward, so the
 * same mesh works for the procedural stand-in and for a delivered `player.glb` (the brief
 * specifies a 1.75 m humanoid, feet at the origin, facing `+Z`).
 */
export function createPlayerWeapon(): PlayerWeapon {
  const root = new Group();
  root.name = 'player-weapon';
  const geometries: BufferGeometry[] = [];
  const materials: MeshStandardMaterial[] = [];

  const material = (colour: number, options: { emissive?: number; emissiveIntensity?: number } = {}) => {
    const created = new MeshStandardMaterial({
      color: colour,
      roughness: 0.42,
      metalness: 0.55,
      ...(options.emissive === undefined
        ? {}
        : { emissive: options.emissive, emissiveIntensity: options.emissiveIntensity ?? 0 }),
    });
    materials.push(created);
    return created;
  };

  const furniture = material(WEAPON_MODEL.colours.furniture, {});
  const steel = material(WEAPON_MODEL.colours.receiver, {});
  const barrelSteel = material(WEAPON_MODEL.colours.barrel, {});
  // The one place the brief asks for a colour rather than a shape: part of the barrel and
  // the muzzle brake are orange, and the small emissive is what keeps them orange under the
  // tone-mapped, blue-grey key light.
  const orange = material(WEAPON_MODEL.colours.muzzle, {
    emissive: WEAPON_MODEL.colours.muzzleEmissive,
    emissiveIntensity: WEAPON_MODEL.colours.muzzleEmissiveIntensity,
  });

  /** Adds one box, in metres, at the configured local offset. */
  const addBox = (
    name: string,
    size: { width: number; height: number; length: number },
    at: { y: number; z: number },
    boxMaterial: MeshStandardMaterial,
    rotationX = 0,
  ): Mesh => {
    const geometry = new BoxGeometry(size.width, size.height, size.length);
    geometries.push(geometry);
    const mesh = new Mesh(geometry, boxMaterial);
    mesh.name = name;
    mesh.position.set(0, at.y, at.z);
    mesh.rotation.x = rotationX;
    root.add(mesh);
    return mesh;
  };

  /** Adds one cylinder lying along `z` — the barrel sections and the muzzle brake. */
  const addTube = (
    name: string,
    radius: number,
    length: number,
    at: { y: number; z: number },
    tubeMaterial: MeshStandardMaterial,
  ): Mesh => {
    const geometry = new CylinderGeometry(radius, radius, length, 12);
    geometries.push(geometry);
    const mesh = new Mesh(geometry, tubeMaterial);
    mesh.name = name;
    mesh.position.set(0, at.y, at.z);
    // A cylinder is built along `y`; a quarter turn about `x` lays it along `z`.
    mesh.rotation.x = Math.PI / 2;
    root.add(mesh);
    return mesh;
  };

  // --- Furniture and receiver ------------------------------------------------
  addBox('stock', WEAPON_MODEL.stock, WEAPON_MODEL.stock, furniture);
  addBox('receiver', WEAPON_MODEL.receiver, WEAPON_MODEL.receiver, steel);
  addBox('magazine', WEAPON_MODEL.magazine, WEAPON_MODEL.magazine, steel);
  addBox('grip', WEAPON_MODEL.grip, WEAPON_MODEL.grip, furniture, WEAPON_MODEL.grip.rakeDeg * DEG2RAD);
  addBox('trigger', WEAPON_MODEL.trigger, WEAPON_MODEL.trigger, furniture);
  addBox('trigger-guard', WEAPON_MODEL.guard, WEAPON_MODEL.guard, furniture);
  addBox('handguard', WEAPON_MODEL.handguard, WEAPON_MODEL.handguard, furniture);

  // --- Barrel ----------------------------------------------------------------
  const barrelY = WEAPON_MODEL.barrel.y;
  addTube('barrel-rear', WEAPON_MODEL.barrel.radius, WEAPON_MODEL.barrel.rear.length, {
    y: barrelY,
    z: WEAPON_MODEL.barrel.rear.z,
  }, barrelSteel);
  addTube('barrel-front', WEAPON_MODEL.barrel.radius, WEAPON_MODEL.barrel.front.length, {
    y: barrelY,
    z: WEAPON_MODEL.barrel.front.z,
  }, orange);
  addTube('muzzle', WEAPON_MODEL.muzzle.radius, WEAPON_MODEL.muzzle.length, WEAPON_MODEL.muzzle, orange);

  /**
   * The whole gun leans as one piece. Pitching the group rather than every mesh keeps the barrel
   * and the stock on the same axis.
   *
   * Only the *built-in* lean lives here. The **anchor is not applied by this function**: since
   * phase 8 the rifle has two homes (the body's hands and the camera's viewmodel pose), and a
   * builder that also positioned itself would be a second, silently stale answer to "where is the
   * gun". `characterRig.ts` owns both placements; `WEAPON_MODEL.anchor` and
   * `VIEW.firstPersonWeapon` are the numbers it applies.
   */
  root.rotation.x = WEAPON_MODEL.pitchDeg * DEG2RAD;

  for (const object of root.children) {
    const mesh = object as Mesh;
    // Per mesh, never on the group: `Object3D.layers` is not inherited. Named here as
    // everywhere else in this project because it is the trap that keeps coming back.
    mesh.layers.disableAll();
    mesh.layers.enable(LAYER_DEFAULT);
    mesh.castShadow = true;
  }

  const rear = WEAPON_MODEL.stock.z - WEAPON_MODEL.stock.length * 0.5;
  const front = WEAPON_MODEL.muzzle.z + WEAPON_MODEL.muzzle.length * 0.5;

  return {
    root,
    length: front - rear,
    dispose() {
      for (const geometry of geometries) geometry.dispose();
      for (const entry of materials) entry.dispose();
      geometries.length = 0;
      materials.length = 0;
      root.clear();
    },
  };
}
