/**
 * Character model loading tests.
 *
 * This is the one render-layer module whose *behaviour* is a hard acceptance
 * criterion: "drop the supplied .glb into the folder and it works with no code
 * change" cannot be verified by looking at a screenshot, and the failure mode it
 * guards against (`Object3D.layers` is not inherited, so a model whose root was
 * tagged is invisible to the hit query) is silent in exactly the way that ships.
 *
 * `buildCharacter` takes an already-built scene on purpose, so the whole module is
 * testable with a hand-made `Group` and no loader, no network and no renderer.
 * Only the scene-graph math runs here; nothing touches WebGL.
 */

import { describe, expect, it } from 'vitest';
import {
  AnimationClip,
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
} from 'three';
import {
  buildCharacter,
  createPlaceholderCharacter,
  findClip,
  LAYER_DEFAULT,
  LAYER_HITTABLE,
  PLAYER_MODEL_HEIGHT,
  SMALL_PLACEHOLDER_HEIGHT,
} from '#/render/models/CharacterLoader';

/** A named box mesh, positioned so its bounding box has a known height. */
function boxMesh(name: string, height: number, y: number): Mesh {
  const mesh = new Mesh(new BoxGeometry(0.5, height, 0.5), new MeshStandardMaterial());
  mesh.name = name;
  mesh.position.y = y;
  return mesh;
}

/** A model whose feet are at y = 0 and whose top is at `height`. */
function standIn(height: number): { root: Group; mesh: Mesh } {
  const root = new Group();
  root.name = 'test-rig';
  const mesh = boxMesh(height >= 1.2 ? 'mixamorig:Head' : 'Body', height, height / 2);
  root.add(mesh);
  return { root, mesh };
}

/** Every mesh in a subtree, in traversal order. */
function meshesOf(root: Object3D): Mesh[] {
  const found: Mesh[] = [];
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (mesh.isMesh) found.push(mesh);
  });
  return found;
}

describe('animation clip matching', () => {
  it('matches clip names by case-insensitive keyword', () => {
    const clips = [new AnimationClip('Idle_01', 1, []), new AnimationClip('mixamorig:Run', 1, [])];
    expect(findClip(clips, ['idle'])?.name).toBe('Idle_01');
    expect(findClip(clips, ['run', 'sprint'])?.name).toBe('mixamorig:Run');
    expect(findClip(clips, ['reload'])).toBeUndefined();
  });

  it('prefers walk over run so one locomotion clip can serve both states', () => {
    // A file whose only cycle is called `walk_run_cycle` must be treated as a walk:
    // the fallback chain then serves `run` from it, instead of `walk` being reported
    // as missing when it is in fact present.
    const clips = [new AnimationClip('walk_run_cycle', 1, [])];
    expect(findClip(clips, ['walk'])?.name).toBe('walk_run_cycle');
  });
});

describe('buildCharacter', () => {
  it('assigns the hit layer to every mesh rather than to the root', () => {
    // The trap: `layers` is not inherited by children, so tagging the root type of a
    // loaded model leaves every real mesh on layer 0.
    const rig = new Group();
    rig.add(boxMesh('Body', 0.8, 0.4), boxMesh('Head', 0.4, 1.0));
    const deep = new Group();
    deep.add(boxMesh('Arm', 0.5, 0.9));
    rig.add(deep);

    const model = buildCharacter(rig, [], 1.2, () => {});
    for (const mesh of meshesOf(model.root)) {
      expect(mesh.layers.isEnabled(LAYER_HITTABLE)).toBe(true);
      expect(mesh.layers.isEnabled(LAYER_DEFAULT)).toBe(false);
    }
    // And the root itself is *not* relied upon for the layer.
    expect(model.root.layers.isEnabled(LAYER_HITTABLE)).toBe(false);
  });

  it('tags each mesh with a hit zone, defaulting to body', () => {
    const rig = new Group();
    rig.add(boxMesh('mixamorig:Head', 0.4, 1.0), boxMesh('Torso', 0.8, 0.4), boxMesh('Neck', 0.1, 0.9));
    const model = buildCharacter(rig, [], 1.2, () => {});
    const zones = meshesOf(model.root).map((mesh) => mesh.userData.hitZone);
    expect(zones).toEqual(['head', 'body', 'head']);
  });

  it('scales a mis-exported model to the requested height and says so', () => {
    // A model exported in centimetres is the classic "the hitbox is wrong" report.
    const rig = standIn(175);
    const warnings: string[] = [];
    const model = buildCharacter(rig.root, [], PLAYER_MODEL_HEIGHT, (message) => warnings.push(message));
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('scaled by');

    model.root.updateMatrixWorld(true);
    const mesh = meshesOf(model.root)[0]!;
    mesh.geometry.computeBoundingBox();
    const world = mesh.matrixWorld.elements;
    // The mesh's own local height times the scale applied to its ancestor.
    const scaleY = Math.hypot(world[4] ?? 0, world[5] ?? 0, world[6] ?? 0);
    expect((mesh.geometry.boundingBox!.max.y - mesh.geometry.boundingBox!.min.y) * scaleY).toBeCloseTo(1.75, 1);
  });

  it('does not rescale a model that is already the right size', () => {
    const rig = standIn(PLAYER_MODEL_HEIGHT);
    const warnings: string[] = [];
    // A clip is supplied so the only thing this test can hear about is the scale.
    buildCharacter(rig.root, [new AnimationClip('idle', 1, [])], PLAYER_MODEL_HEIGHT, (message) =>
      warnings.push(message),
    );
    expect(warnings).toEqual([]);
  });
});

describe('missing-clip degradation', () => {
  const clips = [
    new AnimationClip('idle', 1, []),
    new AnimationClip('walk', 1, []),
  ];

  it('never rejects and reports the states it had to substitute', () => {
    const warnings: string[] = [];
    const { root } = standIn(1.75);
    const model = buildCharacter(root, clips, 1.75, (message) => warnings.push(message));

    expect(model.placeholder).toBe(false);
    expect(model.complete).toBe(false);
    // run borrows walk, shoot and reload borrow idle, death borrows idle.
    expect(model.missing).toContain('run');
    expect(model.missing).toContain('shoot');
    expect(model.missing).toContain('reload');
    expect(model.missing).toContain('death');
    expect(warnings.some((line) => line.includes('falling back'))).toBe(true);
  });

  it('is complete, and quiet, when every state has a clip', () => {
    const all = [
      new AnimationClip('idle', 1, []),
      new AnimationClip('walk', 1, []),
      new AnimationClip('run', 1, []),
      new AnimationClip('shoot', 1, []),
      new AnimationClip('reload', 1, []),
      new AnimationClip('death', 1, []),
    ];
    const warnings: string[] = [];
    const { root } = standIn(1.75);
    const model = buildCharacter(root, all, 1.75, (message) => warnings.push(message));
    expect(model.complete).toBe(true);
    expect(model.missing).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('plays, blends and updates without a clip ever having been resolved', () => {
    // A model with no clips is a statue. That is a degradation, not a crash.
    const warnings: string[] = [];
    const { root } = standIn(1.75);
    const model = buildCharacter(root, [], 1.75, (message) => warnings.push(message));
    expect(() => {
      model.play('idle');
      model.play('run');
      model.play('death');
      model.play('idle');
      model.update(0.016);
    }).not.toThrow();
    expect(warnings.some((line) => line.includes('no usable AnimationClips'))).toBe(true);
  });

  it('holds the death pose instead of walking out of it', () => {
    const all = [new AnimationClip('idle', 1, []), new AnimationClip('death', 1, [])];
    const { root } = standIn(1.75);
    const model = buildCharacter(root, all, 1.75, () => {});
    // Nothing observable from outside except that it does not throw, but the
    // transition is the documented contract: once dying, other states are ignored.
    model.play('death');
    expect(() => {
      model.play('run');
      model.play('idle');
      model.update(0.016);
    }).not.toThrow();
  });
});

describe('placeholder stand-in', () => {
  it('stands in at the requested height when no asset has been delivered', () => {
    const model = createPlaceholderCharacter(SMALL_PLACEHOLDER_HEIGHT);
    expect(model.placeholder).toBe(true);
    expect(model.complete).toBe(false);
    model.root.updateMatrixWorld(true);
    const mesh = meshesOf(model.root)[0];
    expect(mesh).toBeDefined();
    // The capsule is a scaled unit sphere, so its height is the scale times two.
    expect(mesh!.scale.y * 2).toBeCloseTo(SMALL_PLACEHOLDER_HEIGHT, 6);
    expect(mesh!.layers.isEnabled(LAYER_DEFAULT)).toBe(true);
    expect(mesh!.layers.isEnabled(LAYER_HITTABLE)).toBe(false);
  });

  it('is safe to drive and dispose', () => {
    const model = createPlaceholderCharacter(1.75);
    expect(() => {
      model.play('run');
      model.update(0.016);
      model.dispose();
    }).not.toThrow();
  });
});
