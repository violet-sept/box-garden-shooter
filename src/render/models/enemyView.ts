/**
 * Enemy bodies.
 *
 * One pooled `Group` per live enemy, driven entirely by reading simulation state.
 * Nothing here decides anything: whether an enemy is telegraphing, enraged or dead
 * was settled in `game/enemies/**`, and this module's only job is to show it.
 *
 * ## Why the two silhouettes are so different
 *
 * The acceptance criterion is that a player can tell the two archetypes apart at a
 * glance, from behind, while being shot at. So they differ on **four** axes at once
 * rather than one —size (1.1 m against 3.4 m), proportion (narrow and
 * forward-leaning against wide and armoured), palette (dark cyan-grey against rust
 * orange), and the tempo of their motion (fast against ponderous). Any single axis
 * alone is easy to miss; four together survive a glance, fog and a bad monitor.
 *
 * Geometry and materials are created once per archetype and shared by every body,
 * so the whole layer costs a handful of materials no matter how many are on field.
 */

import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
} from 'three';
import type { EnemyArchetypeId } from '../../core/config';
import type { EnemyState } from '../../game/enemies/EnemyState';
import { LAYER_DEFAULT } from './CharacterLoader';

/** What the builder hands back. */
export interface EnemyView {
  readonly root: Group;
  /**
   * Syncs every pooled body to the simulation.
   *
   * `alpha` interpolates between the previous and the current tick position, so a
   * 60 Hz simulation reads smoothly at 144 Hz. Reading `position` directly is the
   * classic cause of "the model is ahead of where I hit it".
   */
  update(enemies: readonly EnemyState[], alpha: number, dt: number): void;
  dispose(): void;
}

/** One pooled body. */
interface BodySlot {
  readonly root: Group;
  readonly kind: EnemyArchetypeId;
  /** Materials whose emissive intensity this slot drives, with their base value. */
  readonly glow: { material: MeshStandardMaterial; base: number }[];
  /** Upper body that pitches forward during a telegraph. */
  readonly leaner: Object3D | null;
  /** Every mesh under the body, so the shadow flags can be switched in one place. */
  readonly meshes: Mesh[];
  /** Seconds since this body's enemy stopped being reported, or `null`. */
  deadSince: number | null;
  /**
   * Whether the simulation reported this body during the current frame.
   *
   * Reset at the top of every `update` and set by {@link acquire}. It exists because
   * "anything unclaimed is a corpse" cannot be inferred from `deadSince === null`:
   * `acquire` clears that field when it hands a slot out, so the old inference marked
   * **every** body as a corpse on **every** frame — including the live ones. The
   * visible symptom was a permanent fraction-of-a-degree forward lean on every living
   * enemy (the collapse pose, applied and then reset by the next frame's `acquire`),
   * which is the kind of thing a screenshot review never catches. It became
   * load-bearing in phase 4: the same pass turns shadow casting off, so the bug
   * escalated from "bodies lean by 0.02 rad" to "no live enemy casts a shadow".
   */
  claimed: boolean;
}

const PALETTE = {
  stalkerBody: 0x37424e,
  stalkerPlate: 0x232b34,
  stalkerGlow: 0x36e0ff,
  wardenBody: 0x54402f,
  wardenPlate: 0x2f2418,
  wardenGlow: 0xff7a2a,
} as const;

/** Seconds a corpse lies on the ground before its slot is recycled. */
const CORPSE_LIFE = 1.4;

/** Creates the enemy view, with a pool that grows on demand and never shrinks. */
export function createEnemyView(): EnemyView {
  const root = new Group();
  root.name = 'enemies';

  const pools = new Map<EnemyArchetypeId, BodySlot[]>();
  /** Slots on screen, live bodies and corpses alike. */
  const live: BodySlot[] = [];

  const acquire = (kind: EnemyArchetypeId): BodySlot => {
    // Claim an on-screen slot of this kind that nothing has claimed yet this frame.
    // A slot still playing out its collapse is fair game: taking it back is what stops
    // a wave from allocating a body per death while the old ones are still on the
    // ground.
    //
    // The check is `claimed`, not `deadSince !== null`. `deadSince` answers "is this
    // body a corpse", which is a different question from "has this frame handed this
    // body to someone" — and the two only look interchangeable while a live body is
    // also flagged as collapsing, which is exactly the confusion the `claimed` flag
    // was added to remove.
    for (const slot of live) {
      if (slot.kind !== kind || slot.claimed) continue;
      slot.claimed = true;
      slot.deadSince = null;
      slot.root.visible = true;
      slot.root.scale.setScalar(1);
      slot.root.rotation.set(0, 0, 0);
      setShadowCasting(slot, true);
      return slot;
    }
    const pool = pools.get(kind);
    const reused = pool && pool.length > 0 ? pool.pop() : undefined;
    if (reused) {
      reused.root.visible = true;
      reused.claimed = true;
      reused.root.scale.setScalar(1);
      reused.root.rotation.set(0, 0, 0);
      reused.deadSince = null;
      setShadowCasting(reused, true);
      live.push(reused);
      return reused;
    }
    const slot = buildBody(kind);
    root.add(slot.root);
    live.push(slot);
    return slot;
  };

  const release = (slot: BodySlot): void => {
    slot.root.visible = false;
    const index = live.indexOf(slot);
    if (index >= 0) live.splice(index, 1);
    const pool = pools.get(slot.kind);
    if (pool) pool.push(slot);
    else pools.set(slot.kind, [slot]);
  };

  return {
    root,

    update(enemies, alpha, dt) {
      const a = Math.min(1, Math.max(0, alpha));

      // Clear the claim flags for this frame. Done as its own pass rather than inline
      // so a slot that is claimed and then released inside the same frame cannot be
      // double-counted.
      for (const slot of live) slot.claimed = false;

      // Bodies are *claimed* by kind rather than matched positionally against the
      // simulation's array.
      //
      // Matching index-to-index looks cheaper and is the obvious first
      // implementation, but it is wrong: the simulation's array is compacted on
      // death (the store swaps the last entry into the freed slot), so the order
      // changes every time something dies. A positional match then reads a kind
      // mismatch, and "repairing" it by releasing the slot and taking a new one of
      // the right kind grows the pool without bound -- exactly the per-frame
      // allocation this layer exists to avoid. Claiming by kind is O(n) over a
      // handful of on-screen bodies and allocates nothing.
      for (const enemy of enemies) {
        // Practice dummies have their own meshes in the level view; this layer
        // exists for live combatants.
        if (enemy.kind === 'dummy' || !enemy.alive) continue;
        const slot = acquire(enemy.kind);
        syncBody(slot, enemy, a);
      }

      // Anything not claimed this frame was not reported, so the simulation stopped
      // tracking it: it died. The slot plays out a short collapse before it is
      // released — an enemy that vanishes on the frame it dies reads as a despawn,
      // not as a kill.
      for (let i = live.length - 1; i >= 0; i -= 1) {
        const slot = live[i];
        if (!slot || slot.claimed || slot.deadSince !== null) continue;
        slot.deadSince = 0;
        // The body is done being simulated, so it is done being drawn twice.
        setShadowCasting(slot, false);
      }
      for (let i = live.length - 1; i >= 0; i -= 1) {
        const slot = live[i];
        if (!slot || slot.deadSince === null) continue;
        slot.deadSince += dt;
        collapse(slot);
        if (slot.deadSince < CORPSE_LIFE) continue;
        release(slot);
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
      pools.clear();
      live.length = 0;
    },
  };
}

/** Places one body and applies its presentation state. */
function syncBody(slot: BodySlot, enemy: EnemyState, alpha: number): void {
  slot.root.position.set(
    enemy.previousPosition.x + (enemy.position.x - enemy.previousPosition.x) * alpha,
    enemy.previousPosition.y + (enemy.position.y - enemy.previousPosition.y) * alpha,
    enemy.previousPosition.z + (enemy.position.z - enemy.previousPosition.z) * alpha,
  );
  slot.root.rotation.y = enemy.view.yaw;

  // --- Telegraph -------------------------------------------------------------
  // The glow is the player's only warning, so it is a two-channel cue: emissive
  // ramps with progress and the upper body pitches forward. Either alone is easy
  // to miss against a busy background, and this is the cue the whole readability
  // budget is spent on.
  const glow = enemy.view.telegraphGlow;
  const flash = enemy.view.hitFlash;
  for (const entry of slot.glow) {
    entry.material.emissiveIntensity = entry.base + glow * 2.4 + flash * 3.4;
  }
  if (slot.leaner) slot.leaner.rotation.x = -glow * 0.38;

  // A slow breathing scale on the Warden only: it is the archetype with time to
  // spare, and stillness at that size reads as a bug rather than as menace.
  if (enemy.kind === 'large') {
    const breathe = 1 + Math.sin(enemy.stateTime * 4) * 0.015;
    slot.root.scale.setScalar(breathe);
  }
}

/** Plays the death collapse on a slot whose enemy has gone. */
function collapse(slot: BodySlot): void {
  const t = Math.min(1, (slot.deadSince ?? 0) / Math.max(CORPSE_LIFE, 1e-6));
  // Fall forward and sink slightly. Kept to one rotation axis so a corpse cannot
  // end up at a bizarre angle after a knockback-launched death.
  slot.root.rotation.x = -t * (Math.PI / 2);
  slot.root.scale.setScalar(Math.max(0.2, 1 - t * 0.35));
  for (const entry of slot.glow) {
    entry.material.emissiveIntensity = entry.base * (1 - t);
  }
}

/**
 * Turns shadow casting on or off for a whole body.
 *
 * Phase 4 shadow audit: a corpse spends 1.4 s on the ground doing nothing, and
 * every mesh in it was still being re-drawn into the shadow map for that whole
 * time —the shadow pass is a *second* full traversal of the scene, so a body that
 * cannot move and is about to shrink to a fifth of its size is the cheapest thing
 * on the field to stop rendering twice. The flag is restored when the slot is
 * recycled, which is why the mesh list is kept on the slot.
 */
function setShadowCasting(slot: BodySlot, cast: boolean): void {
  for (const mesh of slot.meshes) mesh.castShadow = cast;
}

/** Builds one body. Shared geometry, per-kind silhouette. */
function buildBody(kind: EnemyArchetypeId): BodySlot {
  const root = new Group();
  root.name = `enemy:${kind}`;
  const glow: { material: MeshStandardMaterial; base: number }[] = [];
  const meshes: Mesh[] = [];
  let leaner: Object3D | null = null;

  const addMesh = (mesh: Mesh): Mesh => {
    // Per mesh, never on the root: `Object3D.layers` is not inherited, and this is
    // the single most common silent failure in a Three.js project of this shape.
    mesh.layers.disableAll();
    mesh.layers.enable(LAYER_DEFAULT);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    meshes.push(mesh);
    return mesh;
  };

  if (kind === 'large') {
    // Warden: wide, armoured, three heavy segments. Reads as architecture.
    const bodyMaterial = new MeshStandardMaterial({ color: PALETTE.wardenBody, roughness: 0.55, metalness: 0.55 });
    const plateBase = 0.35;
    const plateMaterial = new MeshStandardMaterial({
      color: PALETTE.wardenPlate,
      roughness: 0.4,
      metalness: 0.8,
      emissive: PALETTE.wardenGlow,
      emissiveIntensity: plateBase,
    });
    glow.push({ material: plateMaterial, base: plateBase });

    const torso = new Mesh(new BoxGeometry(2.3, 2.2, 1.7), bodyMaterial);
    torso.position.y = 1.5;
    addMesh(torso);

    const hip = new Mesh(new BoxGeometry(2.0, 0.7, 1.5), bodyMaterial);
    hip.position.y = 0.35;
    addMesh(hip);

    // Shoulder plates are the silhouette's widest point, which is what makes the
    // size difference readable at range where no detail survives.
    for (const side of [-1, 1]) {
      const shoulder = new Mesh(new BoxGeometry(0.85, 1.9, 1.35), plateMaterial);
      shoulder.position.set(side * 1.5, 2.1, 0);
      shoulder.rotation.z = side * 0.12;
      addMesh(shoulder);
    }

    // The weak point: a small, unmistakably hot core set between the shoulders.
    const core = new Mesh(new SphereGeometry(0.36, 14, 10), plateMaterial);
    core.position.y = 3.05;
    addMesh(core);

    const head = new Mesh(new BoxGeometry(0.9, 0.7, 0.8), plateMaterial);
    head.position.y = 3.05;
    head.position.z = -0.55;
    addMesh(head);
    leaner = head;

    return { root, kind, glow, leaner, meshes, deadSince: null, claimed: true };
  }

  // Stalker: narrow, forward-leaning, glowing head. Reads as an animal.
  const bodyMaterial = new MeshStandardMaterial({ color: PALETTE.stalkerBody, roughness: 0.65, metalness: 0.25 });
  const glowBase = 0.35;
  const glowMaterial = new MeshStandardMaterial({
    color: PALETTE.stalkerGlow,
    roughness: 0.3,
    metalness: 0.1,
    emissive: PALETTE.stalkerGlow,
    emissiveIntensity: glowBase,
  });
  glow.push({ material: glowMaterial, base: glowBase });

  const torso = new Mesh(new CylinderGeometry(0.3, 0.22, 0.72, 10), bodyMaterial);
  torso.position.y = 0.72;
  // The forward lean is the silhouette's "about to pounce" read; it stays on the
  // mesh so the telegraph's extra pitch can be added on the head without fighting
  // it.
  torso.rotation.x = 0.22;
  addMesh(torso);

  const hip = new Mesh(new CylinderGeometry(0.22, 0.16, 0.4, 8), bodyMaterial);
  hip.position.y = 0.3;
  addMesh(hip);

  // Two forward-swept blades: cheap, and they make the facing obvious from every
  // angle, which is what the player needs in order to judge a wind-up.
  for (const side of [-1, 1]) {
    const blade = new Mesh(new BoxGeometry(0.07, 0.09, 0.62), bodyMaterial);
    blade.position.set(side * 0.26, 0.82, -0.22);
    blade.rotation.y = side * 0.3;
    addMesh(blade);
  }

  const head = new Mesh(new SphereGeometry(0.2, 12, 10), glowMaterial);
  head.position.y = 1.0;
  addMesh(head);
  leaner = head;

  return { root, kind, glow, leaner, meshes, deadSince: null, claimed: true };
}
