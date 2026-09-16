/**
 * Supply crate bodies: the gold ammo box and the white medkit (phase 11).
 *
 * One pooled `Group` per live crate, driven by reading simulation state — the same shape as
 * `enemyView`, and for the same reason: a crate every twenty seconds for a whole run is
 * exactly the kind of thing that must not allocate a mesh per delivery.
 *
 * ## Why these are built here rather than in `levelView`
 *
 * The level's furniture is *authored* (`level.ts` owns its positions and `levelView` builds
 * it once), while these appear and disappear during a run. They are also the only meshes in
 * the game the player is meant to walk up to and press a key at, so their colours are the
 * brief's words rather than a palette pass: **gold** for ammo, **white with a red cross** for
 * the medkit. Those colours are the whole readability budget for the feature — a player has to
 * tell "bullets" from "health" from thirty metres — so they live in `PICKUPS.colours` and the
 * two crates also differ in *shape* (the ammo box has a raised lid and a latch bar; the medkit
 * has a cross standing proud of its face), which is what survives fog and a bad monitor.
 *
 * ## The one animation
 *
 * A slow spin plus a bob, on render time. It is not decoration: a crate is a 0.9 m box on the
 * floor of a 48 m arena, and a static box at that size reads as more level geometry. The
 * motion is what says "this one is interactive", which is why it is on the supply crates and
 * not on the crates the level is made of.
 */

import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { PICKUPS, type PickupKind } from '../../core/config';
import type { Pickup } from '../../game/pickups/pickupSystem';
import { LAYER_DEFAULT } from '../models/CharacterLoader';

/** The crate layer's public surface. */
export interface PickupView {
  readonly root: Group;
  /** Syncs every pooled crate to the simulation. `time` drives the idle spin. */
  update(pickups: readonly Pickup[], time: number): void;
  /** Hides every body. Called on a run restart, like every other one-shot view. */
  clear(): void;
  dispose(): void;
}

/** One pooled crate body. */
interface CrateSlot {
  readonly root: Group;
  readonly kind: PickupKind;
  /**
   * Whether the simulation reported this crate during the current frame.
   *
   * Cleared at the top of every `update` and set by {@link acquire}. It is a **separate flag
   * from `root.visible`** on purpose: visibility is what the leftovers pass writes, and using
   * it as the claim marker as well means a slot that is still visible from last frame cannot
   * be re-claimed and a freshly built one can be mistaken for a leftover — the same trap
   * `enemyView` documents, and the same reason it keeps its own flag.
   */
  claimed: boolean;
}

/**
 * Spin rate, radians per second.
 *
 * Slow on purpose: this is a marker, not a collectible from an arcade platformer. At ~0.4
 * revolutions a second the crate's four faces are all readable within a couple of seconds of
 * looking at it, which is what lets a player identify it without stopping.
 */
const SPIN_RAD_PER_SEC = 2.4;
/** Bob amplitude and rate, in metres and radians per second. */
const BOB_AMPLITUDE = 0.09;
const BOB_RATE = 2.2;

/** Creates the crate view, with a pool that grows on demand and never shrinks. */
export function createPickupView(): PickupView {
  const root = new Group();
  root.name = 'pickups';

  const pools = new Map<PickupKind, CrateSlot[]>();
  const live: CrateSlot[] = [];

  const build = (kind: PickupKind): CrateSlot => {
    const group = new Group();
    group.name = `pickup:${kind}`;
    const size = PICKUPS.size;

    /** Adds a mesh with this layer enabled, per mesh: `Object3D.layers` is not inherited. */
    const add = (mesh: Mesh, x: number, y: number, z: number): Mesh => {
      mesh.position.set(x, y, z);
      mesh.layers.disableAll();
      mesh.layers.enable(LAYER_DEFAULT);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    };

    if (kind === 'ammo') {
      const body = new MeshStandardMaterial({ color: PICKUPS.colours.ammoBody, roughness: 0.45, metalness: 0.65 });
      const trim = new MeshStandardMaterial({ color: PICKUPS.colours.ammoTrim, roughness: 0.6, metalness: 0.5 });
      const latch = new MeshStandardMaterial({ color: PICKUPS.colours.ammoLatch, roughness: 0.3, metalness: 0.8 });

      // The box, its lid, and a bright latch bar across the lid. Three pieces is enough for
      // the silhouette to read as "an ammunition crate" rather than as a cube.
      add(new Mesh(new BoxGeometry(size, size * 0.72, size * 0.62), body), 0, 0, 0);
      add(new Mesh(new BoxGeometry(size * 1.02, size * 0.16, size * 0.66), trim), 0, size * 0.44, 0);
      add(new Mesh(new BoxGeometry(size * 0.5, size * 0.1, size * 0.1), latch), 0, size * 0.44, 0);
    } else {
      const body = new MeshStandardMaterial({ color: PICKUPS.colours.medkitBody, roughness: 0.55, metalness: 0.25 });
      const trim = new MeshStandardMaterial({ color: PICKUPS.colours.medkitTrim, roughness: 0.6, metalness: 0.4 });
      const cross = new MeshStandardMaterial({
        color: PICKUPS.colours.medkitCross,
        roughness: 0.4,
        metalness: 0.2,
        // A little emissive so the red survives the level's blue-grey light, the same
        // treatment the weapon's orange barrel front gets.
        emissive: PICKUPS.colours.medkitCross,
        emissiveIntensity: 0.18,
      });

      add(new Mesh(new BoxGeometry(size, size * 0.8, size * 0.66), body), 0, 0, 0);
      add(new Mesh(new BoxGeometry(size * 1.04, size * 0.14, size * 0.7), trim), 0, size * 0.42, 0);
      // The cross: two thin bars proud of the front face, which is what makes it a medkit
      // rather than a white box at any distance the rest of the detail has vanished at.
      const armLength = size * 0.62;
      const armWidth = size * 0.18;
      add(new Mesh(new BoxGeometry(armLength, armWidth, size * 0.06), cross), 0, 0, size * 0.34);
      add(new Mesh(new BoxGeometry(armWidth, armLength, size * 0.06), cross), 0, 0, size * 0.34);
    }

    root.add(group);
    return { root: group, kind, claimed: true };
  };

  const acquire = (kind: PickupKind): CrateSlot => {
    // Claim an on-screen slot of this kind that nothing has claimed yet this frame.
    for (const slot of live) {
      if (slot.kind !== kind || slot.claimed) continue;
      slot.claimed = true;
      slot.root.visible = true;
      return slot;
    }
    const pool = pools.get(kind);
    const reused = pool && pool.length > 0 ? pool.pop() : undefined;
    if (reused) {
      reused.claimed = true;
      reused.root.visible = true;
      live.push(reused);
      return reused;
    }
    const slot = build(kind);
    slot.claimed = true;
    root.add(slot.root);
    live.push(slot);
    return slot;
  };

  return {
    root,

    update(pickups, time) {
      // Crate bodies are **claimed by kind** rather than matched positionally against the
      // simulation's array, for the reason `enemyView` documents at length: the simulation's
      // pool is reused, so index-to-index matching reads a kind mismatch and "repairs" it by
      // growing the pool without bound. Claiming by kind is O(n) over four slots.
      for (const slot of live) slot.claimed = false;

      for (const crate of pickups) {
        if (!crate.active) continue;
        const slot = acquire(crate.kind);
        slot.root.position.set(
          crate.position.x,
          crate.position.y + Math.sin(time * BOB_RATE + crate.id) * BOB_AMPLITUDE,
          crate.position.z,
        );
        slot.root.rotation.y = time * SPIN_RAD_PER_SEC;
        slot.root.visible = true;
      }

      // Anything not claimed this frame is not on the field any more: the player took it, or
      // the run restarted. A crate is not an enemy, so there is no collapse — it is gone.
      for (const slot of live) {
        if (!slot.claimed) slot.root.visible = false;
      }
    },

    clear() {
      for (const slot of live) slot.root.visible = false;
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
      pools.clear();
      live.length = 0;
    },
  };
}
