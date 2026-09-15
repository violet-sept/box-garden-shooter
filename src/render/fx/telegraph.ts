/**
 * Warden attack indicators: the warning line, the bolt, and the impact flash.
 *
 * The player's only defence against a Warden is reading which line it is aiming down and
 * stepping off it. That makes these three **gameplay-critical**, not decorative: if the line
 * is late, unclear or wrong, the attack is not dodgeable and the whole "punishes standing in
 * the open" design collapses into "punishes being unlucky".
 *
 * So they are built to four rules:
 *
 *   1. **The line appears when the wind-up starts**, and it is redrawn from the simulation
 *      every frame, so it tracks the player exactly as long as the Warden is still tracking
 *      them. It is the *same* arithmetic that fires the bolt, which is why the line the
 *      player watched and the path the shot takes cannot disagree.
 *   2. **The line fades out at the instant the shot is fired** and the bolt takes over. Two
 *      things describing the same line at once reads as two attacks.
 *   3. **The line brightens as the fuse burns down**, so "how long have I got" is readable
 *      without looking away from it — the same job the old ground rings did with a fill ramp.
 *   4. **Everything is yellow**, and it is the same yellow as the bolt and the flash: the
 *      wind-up, the shot and the impact are one attack in three tenses. The colour comes from
 *      `WARDEN.shotColour` rather than being typed here, because "the attack is yellow" is a
 *      requirement about the game, not a taste decision made in a renderer.
 *
 * Everything is pooled. A Warden can have a bolt in the air while another lines up, and the
 * bar is not the only place a large enemy can be.
 */

import {
  AdditiveBlending,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
} from 'three';
import { WARDEN } from '../../core/config';
import type { Vector3 } from '../../core/math/vec3';
import { IMPACT_WARNING_WINDOW } from '../../game/enemies/frames';

/** How many warning lines and bolts may be drawn at once. Two Wardens plus slack. */
const LINE_POOL = 6;
/** How many impact flashes may be alive at once. */
const FLASH_POOL = 8;
/** Seconds an impact flash stays after a shot ends. */
const FLASH_LIFE = 0.32;
/** Seconds a bolt's streak takes to fade once its shot is retired. */
const BOLT_FADE = 0.06;

/** Where the next shot will go, and how long is left before it does. */
export interface AimLine {
  /** Where the bolt will leave the Warden. */
  readonly origin: Vector3;
  /** Unit direction, recomputed every frame of the wind-up. */
  readonly direction: Vector3;
  /** How far to draw the line, in metres — to the player, not to the weapon's range. */
  readonly length: number;
  /** Seconds until the shot is fired. */
  readonly fuse: number;
  /** Length of the whole wind-up, for the brightness ramp. */
  readonly total: number;
}

/** One bolt in flight. Poses come straight from the simulation every frame. */
export interface ShotMarker {
  readonly position: Vector3;
  /** Unit direction, frozen at launch. */
  readonly direction: Vector3;
  /** Metres travelled last tick, used for the streak's length. */
  readonly trail: number;
}

/** The indicator layer's public surface. */
export interface TelegraphView {
  readonly root: Group;
  /** Draws one warning line per Warden that is winding up. Called every frame. */
  showAimLines(lines: readonly AimLine[]): void;
  /** Draws the bolts currently in the air. Called every frame. */
  showShots(shots: readonly ShotMarker[]): void;
  /** Draws the expanding flash of one shot ending. */
  flash(position: Vector3, radius: number): void;
  /** Advances the flash and bolt animations. `dt` is render time. */
  update(dt: number): void;
  clear(): void;
  dispose(): void;
}

interface LineSlot {
  readonly group: Group;
  readonly beam: Mesh;
  readonly core: Mesh;
}

interface BoltSlot {
  readonly head: Mesh;
  readonly streak: Mesh;
}

/** Creates the pooled Warden-attack layer. */
export function createTelegraphView(): TelegraphView {
  const root = new Group();
  root.name = 'warden-attack';
  // Above the ground, below everything else that might want to be seen.
  root.renderOrder = 1;

  // --- Warning lines --------------------------------------------------------
  // Two meshes per line: a wide soft beam and a thin bright core. One mesh alone reads as
  // either a smear or a hairline depending on the monitor, and the line is the single most
  // important thing on screen for the second and a half before a shot.
  const lines: LineSlot[] = [];
  for (let i = 0; i < LINE_POOL; i += 1) {
    const beamMaterial = new MeshBasicMaterial({
      color: WARDEN.shotColour,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    });
    const coreMaterial = new MeshBasicMaterial({
      color: WARDEN.shotGlowColour,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    });
    // Unit-radius spheres stretched along local Z and oriented with `lookAt`, so one shared
    // geometry serves every line length and a streak never disappears when viewed edge-on.
    const beam = new Mesh(new SphereGeometry(0.075, 8, 6), beamMaterial);
    const core = new Mesh(new SphereGeometry(0.022, 6, 4), coreMaterial);
    const group = new Group();
    group.add(beam, core);
    group.visible = false;
    root.add(group);
    lines.push({ group, beam, core });
  }

  // --- Bolts ---------------------------------------------------------------
  // A hot head plus a stretched tail, the same language the player's own tracers use but
  // scaled up: the bolt is a heavy round, not a bullet.
  const bolts: BoltSlot[] = [];
  for (let i = 0; i < LINE_POOL; i += 1) {
    const headMaterial = new MeshBasicMaterial({
      color: WARDEN.shotGlowColour,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const streakMaterial = new MeshBasicMaterial({
      color: WARDEN.shotColour,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const head = new Mesh(new SphereGeometry(0.34, 12, 10), headMaterial);
    const streak = new Mesh(new SphereGeometry(0.2, 8, 6), streakMaterial);
    head.visible = false;
    streak.visible = false;
    head.frustumCulled = false;
    streak.frustumCulled = false;
    root.add(head, streak);
    bolts.push({ head, streak });
  }

  // --- Impact flashes ------------------------------------------------------
  // An expanding sphere shell rather than a ground ring: this impact can land anywhere from
  // the Warden's chest height to the player's head, and a flat ring floating in mid-air
  // reads as a ground marker that has lost its ground.
  const flashes: { mesh: Mesh; material: MeshBasicMaterial; life: number; radius: number }[] = [];
  for (let i = 0; i < FLASH_POOL; i += 1) {
    const material = new MeshBasicMaterial({
      color: WARDEN.shotColour,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    });
    const mesh = new Mesh(new SphereGeometry(1, 18, 12), material);
    mesh.visible = false;
    mesh.frustumCulled = false;
    root.add(mesh);
    flashes.push({ mesh, material, life: 0, radius: 1 });
  }
  let flashCursor = 0;

  /** Places one stretched segment between two points, into `mesh`. */
  const stretch = (mesh: Mesh, from: Vector3, to: Vector3): void => {
    mesh.position.set((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
    mesh.lookAt(to.x, to.y, to.z);
    const length = Math.max(0.02, Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z));
    mesh.scale.set(1, 1, length);
  };

  /** Reused so a line's far end is computed without allocating. */
  const farEnd = { x: 0, y: 0, z: 0 };

  return {
    root,

    showAimLines(activeLines) {
      // Reuse from index 0 each frame: the caller passes the whole live set, so the pool is a
      // direct mapping rather than a free list.
      for (let i = 0; i < lines.length; i += 1) {
        const slot = lines[i];
        if (!slot) continue;
        const line = activeLines[i];
        if (!line) {
          slot.group.visible = false;
          continue;
        }
        slot.group.visible = true;
        farEnd.x = line.origin.x + line.direction.x * line.length;
        farEnd.y = line.origin.y + line.direction.y * line.length;
        farEnd.z = line.origin.z + line.direction.z * line.length;
        // The same geometry for both meshes; only the material differs, which is what keeps
        // the pair exactly coplanar as the line swings.
        stretch(slot.beam, line.origin, farEnd);
        stretch(slot.core, line.origin, farEnd);
        // Brightness ramps with the fuse, so "how long have I got" is readable from the line
        // itself — the job the old ground ring's fill did. Inside `IMPACT_WARNING_WINDOW` the
        // pulse switches to a fast flicker, which is the last-call signal the constant names.
        const remaining = line.total > 0 ? Math.max(0, Math.min(1, line.fuse / line.total)) : 0;
        const charged = 1 - remaining;
        const pulse = line.fuse <= IMPACT_WARNING_WINDOW
          ? 0.55 + 0.45 * Math.sin(charged * 60)
          : 0.72 + 0.28 * Math.sin(charged * 22);
        (slot.beam.material as MeshBasicMaterial).opacity = (0.16 + charged * 0.3) * pulse;
        (slot.core.material as MeshBasicMaterial).opacity = (0.45 + charged * 0.5) * pulse;
      }
    },

    showShots(shots) {
      for (let i = 0; i < bolts.length; i += 1) {
        const slot = bolts[i];
        if (!slot) continue;
        const shot = shots[i];
        if (!shot) {
          // The simulation retired this shot. The head goes immediately, and the tail is left
          // to `update`, which is what stops a bolt from popping out of existence mid-flight.
          slot.head.visible = false;
          continue;
        }
        slot.head.visible = true;
        slot.streak.visible = true;
        (slot.streak.material as MeshBasicMaterial).opacity = 0.75;
        slot.head.position.set(shot.position.x, shot.position.y, shot.position.z);
        // The streak is the distance covered since the last frame rather than a fixed length,
        // so it stretches naturally during a long frame instead of lagging behind the head.
        const trail = Math.max(0.5, shot.trail);
        farEnd.x = shot.position.x - shot.direction.x * trail;
        farEnd.y = shot.position.y - shot.direction.y * trail;
        farEnd.z = shot.position.z - shot.direction.z * trail;
        stretch(slot.streak, farEnd, shot.position);
      }
    },

    flash(position, radius) {
      const slot = flashes[flashCursor];
      flashCursor = (flashCursor + 1) % flashes.length;
      if (!slot) return;
      slot.mesh.position.set(position.x, position.y, position.z);
      slot.radius = Math.max(0.2, radius);
      slot.mesh.scale.setScalar(slot.radius * 0.5);
      slot.mesh.visible = true;
      slot.life = FLASH_LIFE;
      slot.material.opacity = 0.9;
    },

    update(dt) {
      for (const slot of flashes) {
        if (slot.life <= 0) continue;
        slot.life = Math.max(0, slot.life - dt);
        if (slot.life === 0) {
          slot.mesh.visible = false;
          continue;
        }
        const t = 1 - slot.life / FLASH_LIFE;
        // Expands to the shot's real radius as it fades, so the last thing on screen is the
        // footprint of the thing that hit.
        slot.mesh.scale.setScalar(slot.radius * (0.5 + t * 1.1));
        slot.material.opacity = 0.9 * (1 - t) * (1 - t);
      }

      for (const slot of bolts) {
        if (!slot.streak.visible) continue;
        const material = slot.streak.material as MeshBasicMaterial;
        if (slot.head.visible) {
          material.opacity = 0.75;
          continue;
        }
        material.opacity = Math.max(0, material.opacity - dt / BOLT_FADE);
        if (material.opacity === 0) slot.streak.visible = false;
      }
    },

    clear() {
      for (const slot of lines) slot.group.visible = false;
      for (const slot of bolts) {
        slot.head.visible = false;
        slot.streak.visible = false;
      }
      for (const slot of flashes) {
        slot.mesh.visible = false;
        slot.life = 0;
      }
    },

    dispose() {
      root.traverse((object) => {
        const mesh = object as Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry?.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) for (const entry of material) entry.dispose();
        else material?.dispose();
      });
      root.clear();
    },
  };
}

/** Number of pooled meshes the layer builds, exported for the view tests. */
export const TELEGRAPH_POOL_MESHES = LINE_POOL * 4 + FLASH_POOL;
