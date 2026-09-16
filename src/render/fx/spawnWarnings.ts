/**
 * Ground markers for incoming spawns.
 *
 * A spawn with no warning is indistinguishable from a bug: an enemy simply exists
 * where a moment ago there was nothing, and the player's reaction is "that is
 * unfair" rather than "I should have moved". So every spawn the director orders is
 * announced by a ring on the ground, and the ring is the *only* thing that tells the
 * player which patch of the arena is about to become dangerous.
 *
 * Relationship to `telegraph.ts`: that layer marks a Warden's incoming shot, which is a
 * reaction window the player must act inside. This one marks an arrival, which is
 * information. They share nothing but being visible from a distance, and the two are
 * deliberately different shapes and colours — a ring on the floor against a line in the air —
 * so they cannot be confused when both are on screen at once.
 *
 * Pooled (hard rule 8): a late wave puts several enemies on the ground every second,
 * and a mesh per spawn would be the exact allocation pattern the FX budget exists to
 * forbid.
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
import { DIRECTOR } from '../../core/config';
import type { EventSink, GameEvents } from '../../core/events';

/**
 * Concurrent warnings.
 *
 * The worst case used to be "a late wave's burst"; under the phase-10 script it is exactly
 * one drop — the last one announces **ten** bodies in a single tick — plus the Warden's own
 * ring when the field clears, so 16 holds with slack. A drop is never re-announced while an
 * earlier one is still ringing (they are ten seconds apart and a warning lasts 0.9 s), so
 * this is a ceiling rather than a churn rate.
 */
const WARNING_POOL = 16;

/** Colour of a small enemy's arrival ring. Cool, so it reads as information. */
const SMALL_COLOR = 0x4fd2ff;
/** Colour of the large enemy's arrival ring. Warm, because it is the important one. */
const BOSS_COLOR = 0xff8a3d;

/** The arrival-marker layer's public surface. */
export interface SpawnWarnings {
  readonly root: Group;
  /** Subscribes to `spawn:pending` and the run-ending events. */
  attach(events: EventSink & {
    on<K extends keyof GameEvents>(name: K, handler: (payload: GameEvents[K]) => void): () => void;
  }): void;
  /** Advances every ring. `dt` is render time, deliberately unscaled by hitstop. */
  update(dt: number): void;
  /** Retires every ring. Called on restart so nothing survives a reset. */
  clear(): void;
  dispose(): void;
}

interface WarningSlot {
  readonly group: Group;
  /** The static outer ring, so the footprint is readable before the fill arrives. */
  readonly rim: Mesh;
  /** The disc that grows as the warning runs out. */
  readonly fill: Mesh;
  readonly rimMaterial: MeshBasicMaterial;
  readonly fillMaterial: MeshBasicMaterial;
  /** Seconds of warning left. Zero means the slot is free. */
  life: number;
  /** Total warning this ring was created with, for the fill ramp. */
  total: number;
  boss: boolean;
}

/** Creates the pooled arrival-warning layer. */
export function createSpawnWarnings(): SpawnWarnings {
  const root = new Group();
  root.name = 'spawn-warnings';
  // Above the ground, below everything else that wants to be seen.
  root.renderOrder = 1;

  const slots: WarningSlot[] = [];
  for (let i = 0; i < WARNING_POOL; i += 1) {
    const rimMaterial = new MeshBasicMaterial({
      color: SMALL_COLOR,
      transparent: true,
      opacity: 0.8,
      side: DoubleSide,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const fillMaterial = new MeshBasicMaterial({
      color: SMALL_COLOR,
      transparent: true,
      opacity: 0.25,
      side: DoubleSide,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    // Unit radius again: one geometry, scaled per marker, so retuning the ring size
    // costs nothing.
    const rim = new Mesh(new RingGeometry(0.86, 1, 36), rimMaterial);
    const fill = new Mesh(new CircleGeometry(1, 28), fillMaterial);
    rim.rotation.x = -Math.PI / 2;
    fill.rotation.x = -Math.PI / 2;
    fill.position.y = 0.01;
    rim.position.y = 0.013;
    const group = new Group();
    group.add(fill, rim);
    group.visible = false;
    root.add(group);
    slots.push({ group, rim, fill, rimMaterial, fillMaterial, life: 0, total: 1, boss: false });
  }

  let cursor = 0;

  const retire = (slot: WarningSlot): void => {
    slot.life = 0;
    slot.group.visible = false;
  };

  const clearAll = (): void => {
    for (const slot of slots) retire(slot);
  };

  /** Next free slot, or the oldest one if the pool is saturated. */
  const claim = (): WarningSlot => {
    for (const slot of slots) {
      if (slot.life <= 0) return slot;
    }
    // Saturated: overwrite in round-robin order rather than skipping the warning
    // entirely. A missing warning is worse than a recycled one.
    const slot = slots[cursor % slots.length];
    cursor += 1;
    return slot ?? slots[0]!;
  };

  return {
    root,

    attach(events) {
      events.on('spawn:pending', (payload) => {
        const slot = claim();
        const radius = payload.archetype === 'large' ? DIRECTOR.spawnWarningRadiusBoss : DIRECTOR.spawnWarningRadius;
        slot.boss = payload.archetype === 'large';
        slot.total = Math.max(payload.warning, 1e-3);
        slot.life = slot.total;
        slot.group.position.set(payload.position.x, 0, payload.position.z);
        slot.group.scale.setScalar(radius);
        slot.group.visible = true;
        const color = slot.boss ? BOSS_COLOR : SMALL_COLOR;
        slot.rimMaterial.color.setHex(color);
        slot.fillMaterial.color.setHex(color);
        slot.fill.scale.setScalar(0.02);
      });

      // A run that ends takes its pending arrivals with it: the director cancels them,
      // and a ring left on the ground would promise an enemy that is never coming.
      events.on('run:victory', () => clearAll());
      events.on('run:defeat', () => clearAll());
    },

    update(dt) {
      for (const slot of slots) {
        if (slot.life <= 0) continue;
        slot.life = Math.max(0, slot.life - dt);
        if (slot.life === 0) {
          slot.group.visible = false;
          continue;
        }
        // The fill closes in as the enemy gets closer. One visual language for "how long
        // have I got", shared with the Warden's warning line's brightness ramp.
        const remaining = slot.life / slot.total;
        const filled = 1 - remaining;
        slot.fill.scale.setScalar(Math.max(0.02, filled));
        slot.fillMaterial.opacity = 0.12 + filled * 0.28;
        // Plus a pulse that speeds up, the second channel for the same information.
        const pulse = 0.72 + 0.28 * Math.sin((1 - remaining) * 22);
        slot.rimMaterial.opacity = 0.5 + 0.42 * pulse;
        if (slot.boss) slot.group.scale.multiplyScalar(1 + dt * 0.25);
      }
    },

    clear() {
      clearAll();
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
