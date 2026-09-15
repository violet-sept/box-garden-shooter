/**
 * Whitebox level geometry.
 *
 * Builds `InstancedMesh` groups from the *same* prop list the simulation
 * collides against (`game/level.ts`), so "the crate you can shoot" and "the crate
 * that stops bullets" cannot drift apart. One prop array, two consumers — the
 * alternative (authoring meshes and collision separately) is how level bugs that
 * only reproduce at one angle get created.
 *
 * Draw-call strategy: props are grouped by `kind` and drawn as one
 * `InstancedMesh` per group. The arena's ~120 props collapse to about eight draw
 * calls, which is what leaves headroom in the 9 ms render budget.
 */

import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
} from 'three';
import { RENDER } from '../../core/config';
import { DEG2RAD } from '../../core/math/vec3';
import { DECOR_SPECS, type Decor, type LevelData, type Prop, type PropKind, type TargetSpec } from '../../game/level';
import { createRng, seedFromString } from '../../core/math/rng';

/** Layers used by the renderer. Layer 0 is the level; see the shot resolver. */
export const LAYER_DEFAULT = 0;

/** What the builder hands back, so the caller can update or dispose it. */
export interface LevelView {
  readonly root: Group;
  /** Per-target visual state, keyed by target id. */
  readonly targetViews: ReadonlyMap<number, TargetView>;
  /** Advances target bob and hit flashes. `dt` is render time, not sim time. */
  update(time: number): void;
  /** Re-applies target alive/hit state after a reset. */
  refresh(): void;
  dispose(): void;
}

/** The visual half of one practice target. */
export interface TargetView {
  readonly root: Group;
  readonly id: number;
  /** Yaw of the dummy's facing, applied to the group. */
  readonly baseYaw: number;
  /** Last observed health, used to detect a hit and flash. */
  lastHealth: number;
  /** True while the dummy is on the floor. */
  down: boolean;
}

/** Material palette. Kept in one table so the art direction is adjustable in one place. */
const SURFACE: Record<PropKind, { roughness: number; metalness: number; emissive?: number }> = {
  ground: { roughness: 0.95, metalness: 0.0 },
  fence: { roughness: 0.6, metalness: 0.5 },
  crate: { roughness: 0.85, metalness: 0.05 },
  pillar: { roughness: 0.7, metalness: 0.15 },
  lowWall: { roughness: 0.9, metalness: 0.0 },
  platform: { roughness: 0.85, metalness: 0.05 },
  ramp: { roughness: 0.9, metalness: 0.0 },
  barrel: { roughness: 0.5, metalness: 0.6, emissive: 0x2a0b06 },
};

/** Builds the full static level view. */
export function createLevelView(level: LevelData): LevelView {
  const root = new Group();
  root.name = 'level';

  /** Props sharing a geometry signature, gathered so each group is one draw call. */
  const byKind = new Map<PropKind, Prop[]>();
  for (const prop of level.props) {
    const bucket = byKind.get(prop.kind);
    if (bucket) bucket.push(prop);
    else byKind.set(prop.kind, [prop]);
  }

  const disposables: { dispose(): void }[] = [];
  const dummy = new Object3D();

  for (const [kind, props] of byKind) {
    const mesh = buildInstancedGroup(kind, props, dummy);
    root.add(mesh);
    trackDisposables(mesh, disposables);
  }

  // --- Decorative extras ----------------------------------------------------
  for (const decor of level.decor) {
    const object = buildDecor(decor);
    root.add(object);
    trackDisposables(object, disposables);
  }

  // --- Practice targets -----------------------------------------------------
  const targetViews = new Map<number, TargetView>();
  const targetRng = createRng(seedFromString('targets'));
  for (const spec of level.targets) {
    const view = buildTarget(spec, targetRng);
    root.add(view.root);
    targetViews.set(view.id, view);
    trackDisposables(view.root, disposables);
  }

  return {
    root,
    targetViews,
    update(time) {
      for (const view of targetViews.values()) {
        if (view.down) {
          // Toppled: lie flat rather than vanish, so a cleared range reads as
          // "you knocked them down" instead of "they despawned".
          view.root.rotation.x = -Math.PI / 2;
          continue;
        }
        const spec = targetSpecOf(view, level);
        if (spec && spec.bobAmplitude > 0 && spec.bobHz > 0) {
          const offset = Math.sin(time * spec.bobHz * Math.PI * 2) * spec.bobAmplitude;
          view.root.position.x = spec.base.x + offset;
        }
      }
    },
    refresh() {
      for (const view of targetViews.values()) {
        view.down = false;
        view.lastHealth = Number.POSITIVE_INFINITY;
        view.root.rotation.x = 0;
        const spec = targetSpecOf(view, level);
        if (spec) view.root.position.set(spec.base.x, spec.base.y, spec.base.z);
      }
    },
    dispose() {
      for (const entry of disposables) entry.dispose();
      root.clear();
    },
  };
}

/** Looks a target's spec back up. Targets are few, so a scan is fine. */
function targetSpecOf(view: TargetView, level: LevelData): TargetSpec | undefined {
  return level.targets.find((spec) => spec.id === view.id);
}

/** Builds one `InstancedMesh` for every prop sharing a kind. */
function buildInstancedGroup(kind: PropKind, props: readonly Prop[], dummy: Object3D): InstancedMesh {
  // Unit cube scaled per instance: one geometry, many sizes, no reallocation.
  const geometry = kind === 'barrel' ? new CylinderGeometry(0.5, 0.5, 1, 12) : new BoxGeometry(1, 1, 1);
  const surface = SURFACE[kind];
  const material = new MeshStandardMaterial({
    color: new Color(props[0]?.color ?? 0x888888),
    roughness: surface.roughness,
    metalness: surface.metalness,
    emissive: new Color(surface.emissive ?? 0x000000),
  });

  const mesh = new InstancedMesh(geometry, material, props.length);
  mesh.name = `props:${kind}`;
  mesh.castShadow = kind !== 'ground';
  mesh.receiveShadow = true;
  mesh.layers.set(LAYER_DEFAULT);

  for (let i = 0; i < props.length; i += 1) {
    const prop = props[i];
    if (!prop) continue;
    dummy.position.set(prop.position.x, prop.position.y, prop.position.z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(prop.size.x, prop.size.y, prop.size.z);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  // Instanced meshes are static; the bounding sphere is computed once.
  mesh.computeBoundingSphere();
  return mesh;
}

/**
 * Builds a decorative piece.
 *
 * Every dimension here comes from `DECOR_SPECS` in `game/level.ts`, which is the same table
 * `decorCollisionBoxes` derives the piece's physical body from. That is the whole reason the
 * table exists: the mesh and the collision box are two readings of one set of numbers, so a
 * lamp post cannot end up 10 cm thinner than the thing that stops the player.
 */
function buildDecor(decor: Decor): Group {
  const group = new Group();
  group.name = `decor:${decor.kind}`;
  group.position.set(decor.position.x, decor.position.y, decor.position.z);
  group.rotation.y = ((decor.yawDeg ?? 0) * Math.PI) / 180;

  if (decor.kind === 'lamp') {
    const spec = DECOR_SPECS.lamp;
    const pole = new Mesh(
      new CylinderGeometry(spec.poleTopRadius, spec.poleBottomRadius, spec.poleHeight, 8),
      new MeshStandardMaterial({ color: 0x59636f, roughness: 0.5, metalness: 0.6 }),
    );
    pole.position.y = spec.poleHeight / 2;
    pole.castShadow = true;
    group.add(pole);

    const head = new Mesh(
      new SphereGeometry(spec.headRadius, 12, 8),
      new MeshStandardMaterial({ color: 0x0d0f13, emissive: 0xffd9a0, emissiveIntensity: 1.6 }),
    );
    head.position.y = spec.headHeight;
    group.add(head);
    return group;
  }

  if (decor.kind === 'pipeRun') {
    // A parallel run of three pipes on short trestles. Waist high, and solid since phase 6:
    // it is cover you can crouch-walk behind by walking up to it, and it stops bullets.
    const spec = DECOR_SPECS.pipeRun;
    const length = decor.length ?? spec.defaultLength;
    const pipeMaterial = new MeshStandardMaterial({ color: 0x76808c, roughness: 0.45, metalness: 0.7 });
    const trestleMaterial = new MeshStandardMaterial({ color: 0x3b434d, roughness: 0.85 });
    for (let i = 0; i < spec.pipeCount; i += 1) {
      const pipe = new Mesh(new CylinderGeometry(spec.pipeRadius, spec.pipeRadius, length, 10), pipeMaterial);
      pipe.rotation.z = Math.PI / 2;
      pipe.position.y = spec.firstPipeHeight + i * spec.pipeSpacing;
      group.add(pipe);
    }
    const trestleCount = Math.max(2, Math.round(length / spec.trestleEvery));
    for (let i = 0; i < trestleCount; i += 1) {
      const post = new Mesh(
        new BoxGeometry(spec.trestleWidth, spec.trestleHeight, spec.trestleDepth),
        trestleMaterial,
      );
      post.position.set(-length / 2 + (length * i) / (trestleCount - 1), spec.trestleHeight / 2, 0);
      post.castShadow = true;
      group.add(post);
    }
    return group;
  }

  if (decor.kind === 'antenna') {
    const spec = DECOR_SPECS.antenna;
    const mast = new Mesh(
      new CylinderGeometry(spec.mastTopRadius, spec.mastBottomRadius, spec.mastHeight, 6),
      new MeshStandardMaterial({ color: 0x6b7683, roughness: 0.4, metalness: 0.7 }),
    );
    mast.position.y = spec.mastHeight / 2;
    group.add(mast);
    const tip = new Mesh(
      new SphereGeometry(spec.tipRadius, 10, 8),
      new MeshStandardMaterial({ color: 0x14181e, emissive: 0xff5a4d, emissiveIntensity: 2.2 }),
    );
    tip.position.y = spec.tipHeight;
    group.add(tip);
    return group;
  }

  // Crate stack: three boxes, for silhouette variety — and three collision boxes, one per
  // crate, because the stack is stepped and the top crate does not reach over the bottom one.
  const spec = DECOR_SPECS.crateStack;
  let y = 0;
  for (let i = 0; i < spec.sizes.length; i += 1) {
    const size = spec.sizes[i] ?? 1;
    const box = new Mesh(
      new BoxGeometry(size, size, size),
      new MeshStandardMaterial({ color: i % 2 === 0 ? 0x8a6a44 : 0x9c7a4e, roughness: 0.9 }),
    );
    box.position.set((i - 1) * spec.stepX, y + size / 2, (i - 1) * spec.stepZ);
    box.rotation.y = i * spec.yawStepRad;
    box.castShadow = true;
    box.receiveShadow = true;
    group.add(box);
    y += size;
  }
  return group;
}

/**
 * Builds one practice dummy.
 *
 * The silhouette is deliberately blocky and colour-coded — a bright weak point on
 * a dark body — because in phase 1 it has to communicate "shoot the glowing bit"
 * with no UI at all.
 */
function buildTarget(spec: TargetSpec, _rng: ReturnType<typeof createRng>): TargetView {
  const root = new Group();
  root.name = `target:${spec.id}`;
  root.position.set(spec.base.x, spec.base.y, spec.base.z);
  root.rotation.y = spec.yawDeg * DEG2RAD;

  const bodyMaterial = new MeshStandardMaterial({ color: 0x5a6472, roughness: 0.7, metalness: 0.15 });
  const body = new Mesh(
    new CylinderGeometry(spec.bodyRadius, spec.bodyRadius * 0.85, spec.bodyHeight, 12),
    bodyMaterial,
  );
  body.position.y = spec.bodyHeight / 2;
  body.castShadow = true;
  body.receiveShadow = true;
  root.add(body);

  // A shoulder bar makes the facing direction readable at a glance.
  const shoulders = new Mesh(
    new BoxGeometry(spec.bodyRadius * 3.4, 0.16, spec.bodyRadius * 0.9),
    new MeshStandardMaterial({ color: 0x49525e, roughness: 0.75 }),
  );
  shoulders.position.y = spec.bodyHeight * 0.92;
  shoulders.castShadow = true;
  root.add(shoulders);

  const head = new Mesh(
    new SphereGeometry(spec.headRadius, 14, 10),
    new MeshStandardMaterial({ color: 0xff4d3d, emissive: 0xff2a17, emissiveIntensity: 1.4, roughness: 0.35 }),
  );
  head.position.y = spec.bodyHeight + spec.headRadius;
  head.castShadow = true;
  root.add(head);

  const stand = new Mesh(
    new CylinderGeometry(0.06, 0.06, 0.35, 6),
    new MeshStandardMaterial({ color: 0x2f353d, roughness: 0.9 }),
  );
  stand.position.y = 0.175;
  root.add(stand);

  return { root, id: spec.id, baseYaw: spec.yawDeg * DEG2RAD, lastHealth: Number.POSITIVE_INFINITY, down: false };
}

/** Collects every geometry/material under a subtree so `dispose` can free them. */
function trackDisposables(object: Object3D, sink: { dispose(): void }[]): void {
  object.traverse((child) => {
    const mesh = child as Partial<Mesh>;
    if (mesh.geometry) sink.push(mesh.geometry);
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const entry of material) sink.push(entry);
    } else if (material) {
      sink.push(material);
    }
  });
}

/** Applies the render tuning that depends on the level's extent. Shadow map size. */
export function configureShadows(_level: LevelData): { mapSize: number } {
  return { mapSize: RENDER.shadowMapSize };
}
