/**
 * Items in flight.
 *
 * The simulation owns where a thrown item is; this layer only draws it. It reads the
 * item pool every frame rather than subscribing to `item:thrown`, because the pose is
 * a continuously changing fact — a pushed position would need its own interpolation
 * and would inevitably drift out of step with the blast it is about to produce.
 *
 * Pooled (hard rule 8). A thrown object carries a geometry-sized mesh, which makes it
 * the most expensive per-instance effect in the project; "new one per throw" here is
 * worse than anywhere else in the FX budget, and it is the exact thing the budget
 * exists to prevent.
 */

import { AdditiveBlending, Group, Mesh, MeshBasicMaterial, SphereGeometry } from 'three';
import { ITEMS } from '../../core/config';
import type { Throwable } from '../../game/items/throwable';

/** Concurrent item meshes. The belt caps at `ITEMS.maxCharges`, so this is slack. */
const MESH_POOL = 8;

/** The item layer's public surface. */
export interface ThrowableView {
  readonly root: Group;
  /** Re-poses every mesh from the simulation's pool. `dt` is render time. */
  update(throwables: readonly Throwable[], dt: number): void;
  /** Hides every mesh. Called on restart so nothing survives a reset. */
  clear(): void;
  dispose(): void;
}

interface MeshSlot {
  readonly mesh: Mesh;
  readonly material: MeshBasicMaterial;
  /** Id of the item currently occupying this slot, or 0 when the slot is free. */
  itemId: number;
  /** Pulse phase in turns, advanced by the fuse's urgency rather than by time alone. */
  phase: number;
}

/**
 * Creates the pooled item layer.
 *
 * `dt` drives only the pulse, never the position: the pose comes from the simulation,
 * so a frame that covers two simulation ticks still shows the item exactly where the
 * simulation says it is.
 */
export function createThrowableView(): ThrowableView {
  const root = new Group();
  root.name = 'throwables';

  const geometry = new SphereGeometry(ITEMS.radius, 12, 10);
  const slots: MeshSlot[] = [];
  for (let i = 0; i < MESH_POOL; i += 1) {
    const material = new MeshBasicMaterial({
      color: 0x7fe3a0,
      transparent: true,
      opacity: 0.95,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new Mesh(geometry, material);
    mesh.visible = false;
    // The item is small and fast; culling it per frame costs more than drawing it.
    mesh.frustumCulled = false;
    root.add(mesh);
    slots.push({ mesh, material, itemId: 0, phase: 0 });
  }

  return {
    root,

    update(throwables, dt) {
      // Two passes rather than a per-frame `Set` (stage-2 lesson): the first claims a
      // slot per live item, the second retires whatever was not claimed. A `Set`
      // allocated every frame is 60 short-lived containers a second for nothing.
      const claimed = new Array<boolean>(slots.length).fill(false);
      let cursor = 0;

      for (const item of throwables) {
        if (!item.active) continue;
        // Find the next free slot, starting where the last claim left off.
        let chosen = -1;
        for (let i = 0; i < slots.length; i += 1) {
          const index = (cursor + i) % slots.length;
          if (!claimed[index]) {
            chosen = index;
            break;
          }
        }
        if (chosen < 0) break;
        cursor = (chosen + 1) % slots.length;
        claimed[chosen] = true;

        const slot = slots[chosen]!;
        // A slot handed a different item starts its pulse from zero, so the blink is
        // always "this item's fuse" rather than "how long this mesh has existed".
        if (slot.itemId !== item.id) slot.phase = 0;
        slot.itemId = item.id;
        slot.mesh.position.set(item.position.x, item.position.y, item.position.z);
        slot.mesh.visible = true;

        // The pulse speeds up as the fuse runs down: a slow throb turning into a rapid
        // blink is readable at a glance without a timer or a number. Clamped to at most
        // one cycle per rendered frame, so a long frame cannot alias it into a stall.
        const remaining = Math.max(0, Math.min(1, item.fuseRemaining / Math.max(ITEMS.fuse, 1e-3)));
        const urgency = 1 - remaining;
        slot.phase = (slot.phase + Math.min(0.5, dt * (2 + urgency * 14))) % 1;
        const pulse = 0.5 + 0.5 * Math.sin(slot.phase * Math.PI * 2);
        slot.material.opacity = 0.5 + 0.45 * pulse;
        // Larger and hotter as it is about to go off: the same information again, in a
        // channel that survives being looked at edge-on.
        slot.mesh.scale.setScalar(1 + urgency * 0.5);
        slot.material.color.setRGB(0.5 + urgency * 0.5, 0.89, 0.63 - urgency * 0.35);
      }

      for (let i = 0; i < slots.length; i += 1) {
        if (claimed[i]) continue;
        const slot = slots[i]!;
        if (!slot.mesh.visible) continue;
        slot.mesh.visible = false;
        slot.itemId = 0;
        slot.phase = 0;
      }
    },

    clear() {
      for (const slot of slots) {
        slot.mesh.visible = false;
        slot.itemId = 0;
        slot.phase = 0;
      }
    },

    dispose() {
      geometry.dispose();
      for (const slot of slots) slot.material.dispose();
      root.clear();
    },
  };
}
