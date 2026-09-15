/**
 * Telegraph indicators.
 *
 * The player's only defence against a Warden is reading where its shells will land
 * and walking out. That makes these markers **gameplay-critical**, not decorative:
 * if they are late, unclear or wrong, the attack is not dodgeable and the whole
 * "punishes standing in the open" design collapses into "punishes being unlucky".
 *
 * So they are built to three rules:
 *
 *   1. **They appear when the impact points are locked**, which is at the end of the
 *      telegraph, and not a frame earlier. Showing markers that later move teaches
 *      the player to ignore markers.
 *   2. **They fill from the rim inward** as the fuse burns down, so "how long have I
 *      got" is readable without looking away from the ground.
 *   3. **They are drawn on the ground plane with no depth write**, so they are never
 *      hidden by the very crates the player is standing behind. A warning you cannot
 *      see because of cover is worse than no warning.
 *
 * Every ring is pooled: the Warden can have three in the air at once and phase 3's
 * wave director can put several Wardens on the field.
 */

import {
  AdditiveBlending,
  CircleGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
} from 'three';
import { ENEMY, WARDEN } from '../../core/config';
import type { Vector3 } from '../../core/math/vec3';

/** How many rings may be alive at once. Two Wardens' worth of barrages, plus slack. */
const RING_POOL = 12;

/** Seconds an impact flash stays after a blast detonates. */
const FLASH_LIFE = 0.45;

/** Where an impact is expected and when. */
export interface ImpactMarker {
  readonly position: Vector3;
  readonly radius: number;
  /** Seconds until detonation. Zero or less means "now". */
  readonly fuse: number;
  /** Total fuse this marker was created with, for the fill ramp. */
  readonly total: number;
}

/** The indicator layer's public surface. */
export interface TelegraphView {
  readonly root: Group;
  /** Lights up a melee attacker's body. Called every frame with the live state. */
  showBarrageMarkers(markers: readonly ImpactMarker[]): void;
  /** Draws the expanding flash of one detonation. */
  flash(position: Vector3, radius: number): void;
  /** Advances the flash animations. `dt` is render time. */
  update(dt: number): void;
  clear(): void;
  dispose(): void;
}

interface RingSlot {
  readonly group: Group;
  /** Outer ring: the blast diameter. Static. */
  readonly rim: Mesh;
  /** Inner disc: grows as the fuse burns down. */
  readonly fill: Mesh;
  life: number;
  active: boolean;
}

/** Creates the pooled ground-marker layer. */
export function createTelegraphView(): TelegraphView {
  const root = new Group();
  root.name = 'telegraph';
  // Above the ground, below everything else that might want to be seen.
  root.renderOrder = 1;

  const rings: RingSlot[] = [];
  for (let i = 0; i < RING_POOL; i += 1) {
    // Unit radius: the mesh is scaled per marker, so one geometry serves every
    // blast size and a tuning change costs nothing.
    const rimMaterial = new MeshBasicMaterial({
      color: 0xff6a2a,
      transparent: true,
      opacity: 0.85,
      side: DoubleSide,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const fillMaterial = new MeshBasicMaterial({
      color: 0xff3b1a,
      transparent: true,
      opacity: 0.3,
      side: DoubleSide,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const rim = new Mesh(new RingGeometry(0.9, 1, 40), rimMaterial);
    const fill = new Mesh(new CircleGeometry(1, 32), fillMaterial);
    // Flat on the ground. `rotation.x = -PI/2` puts the geometry's +Y normal up,
    // which is what makes the ring read as painted on the floor rather than
    // standing upright.
    rim.rotation.x = -Math.PI / 2;
    fill.rotation.x = -Math.PI / 2;
    // A hair above the slab so it does not z-fight with the ground.
    fill.position.y = 0.012;
    rim.position.y = 0.014;
    const group = new Group();
    group.add(fill, rim);
    group.visible = false;
    root.add(group);
    rings.push({ group, rim, fill, life: 0, active: false });
  }

  /** Expanding shockwave discs, one per recent detonation. */
  const flashes: { mesh: Mesh; life: number }[] = [];
  for (let i = 0; i < RING_POOL; i += 1) {
    const material = new MeshBasicMaterial({
      color: 0xffb066,
      transparent: true,
      opacity: 0.9,
      side: DoubleSide,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const mesh = new Mesh(new RingGeometry(0.86, 1, 36), material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.02;
    mesh.visible = false;
    root.add(mesh);
    flashes.push({ mesh, life: 0 });
  }
  let flashCursor = 0;

  return {
    root,

    showBarrageMarkers(markers) {
      // Reuse from index 0 each frame: the caller passes the whole live set, so the
      // pool is a direct mapping rather than a free list.
      for (let i = 0; i < rings.length; i += 1) {
        const slot = rings[i];
        if (!slot) continue;
        const marker = markers[i];
        if (!marker) {
          slot.group.visible = false;
          slot.active = false;
          continue;
        }
        slot.active = true;
        slot.group.visible = true;
        slot.group.position.set(marker.position.x, 0, marker.position.z);
        slot.group.scale.setScalar(marker.radius);
        // Fill grows from nothing to the full disc as the fuse burns down, so the
        // player reads "how long" from the amount of ground already covered.
        const remaining = marker.total > 0 ? Math.max(0, Math.min(1, marker.fuse / marker.total)) : 0;
        const filled = 1 - remaining;
        slot.fill.scale.setScalar(Math.max(0.02, filled));
        (slot.fill.material as MeshBasicMaterial).opacity = 0.14 + filled * 0.3;
        // The rim pulses faster as it gets closer, which is the second channel for
        // the same information and the one that survives being looked at edge-on.
        const pulse = 0.7 + 0.3 * Math.sin((1 - remaining) * 18);
        (slot.rim.material as MeshBasicMaterial).opacity = 0.55 + 0.4 * pulse;
      }
    },

    flash(position, radius) {
      const slot = flashes[flashCursor];
      flashCursor = (flashCursor + 1) % flashes.length;
      if (!slot) return;
      slot.mesh.position.set(position.x, 0.02, position.z);
      slot.mesh.scale.setScalar(radius);
      slot.mesh.visible = true;
      slot.life = FLASH_LIFE;
      (slot.mesh.material as MeshBasicMaterial).opacity = 0.9;
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
        slot.mesh.scale.multiplyScalar(1 + t * 0.06);
        (slot.mesh.material as MeshBasicMaterial).opacity = 0.9 * (slot.life / FLASH_LIFE);
      }
    },

    clear() {
      for (const slot of rings) {
        slot.group.visible = false;
        slot.active = false;
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

/** Total fuse a marker is created with, from config. Exported for the caller. */
export const BARRAGE_FUSE = ENEMY.barrageStagger * Math.max(1, ENEMY.barrageBlasts - 1);

/** Warden band, re-exported so the debug overlay can show the distance hold. */
export const WARDEN_BAND = { min: WARDEN.bandMin, max: WARDEN.bandMax } as const;
