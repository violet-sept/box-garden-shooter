/**
 * Whitebox level data — the authoritative collision world.
 *
 * This module owns *shapes and positions*, not meshes. Both consumers derive
 * from the same arrays: `render/scene/level.ts` builds `InstancedMesh`
 * geometry from `props`, and the movement/hitscan systems test against
 * `collisionBoxes` and `blockers`. Authoring cover once and consuming it twice
 * is the only way "the wall you can see" and "the wall that stops bullets" stay
 * the same wall.
 *
 * Layout rules that the gameplay depends on (technical plan §3.6):
 *   - The arena is a closed box: fence collision is built from the perimeter so
 *     a player can never walk off the diorama.
 *   - Blockers are sized so a standing player (1.75 m) can shoot over most of
 *     them but not all: cover has to force movement, not camping.
 *   - Everything is placed from a seeded RNG, so the whitebox is identical on
 *     every launch and in every test run.
 */

import { createRng, seedFromString } from '../core/math/rng';
import { type Aabb, type Vector3, DEG2RAD } from '../core/math/vec3';

/** Surface family. Drives material colour and the impact effect that spawns. */
export type PropKind =
  | 'ground'
  | 'fence'
  | 'crate'
  | 'pillar'
  | 'lowWall'
  | 'platform'
  | 'ramp'
  | 'barrel';

/** One authored piece of level geometry. */
export interface Prop {
  /** Readable identifier; also seeds per-prop variation. */
  readonly id: string;
  readonly kind: PropKind;
  /** Centre of the box. */
  readonly position: Vector3;
  /** Full size (not half-extents) along each axis. */
  readonly size: Vector3;
  /** Base colour. Materials are shared per kind, colour is per instance group. */
  readonly color: number;
  /** Blocks player movement. Almost always true. */
  readonly solid: boolean;
  /** Stops bullets and blasts. False for fences and railings. */
  readonly blocksShots: boolean;
}

/**
 * A lamp post, a mast, a stack of crates or a run of pipes.
 *
 * ## These are solid (phase 6)
 *
 * The channel was introduced in phase 4 for "look at it, never collide with it", and this
 * comment used to say so. It does not any more: walking through a lamp post, a crate stack
 * or a waist-high pipe run is the thing players report as a bug, and "it is only decor" is
 * not an answer they can see. Every piece now has a physical body, derived from the same
 * dimensions the mesh is built from — see {@link DECOR_SPECS} and
 * {@link decorCollisionBoxes}.
 *
 * What survives from the original contract is the reason the channel existed at all:
 * `props` derives the meshes, the movement boxes **and** the shot blockers at once, so
 * moving a crate in `props` silently rewrites the playable space. `decor` is where the
 * pieces that are *placed from a list* live, and it now derives exactly the same three
 * things from a single dimension table rather than leaving two of them out.
 */
export interface Decor {
  readonly kind: DecorKind;
  readonly position: Vector3;
  /** Degrees of yaw. Only used by pieces that are not rotationally symmetric. */
  readonly yawDeg?: number;
  /** Length along the local X axis, for the pieces that have one. Metres. */
  readonly length?: number;
}

/** The decorative piece families. */
export type DecorKind = 'lamp' | 'antenna' | 'crateStack' | 'pipeRun';

/**
 * Dimensions of every decorative piece, in metres.
 *
 * One table, two consumers — the same contract `props` has. `render/scene/levelView.ts`
 * builds the meshes from these numbers and {@link decorCollisionBoxes} derives the physical
 * boxes from them, so "the lamp you can see" and "the lamp that stops you" cannot drift
 * apart. Before this table the numbers lived only in the view, which is why the collision
 * side could not have been written at all without duplicating them.
 */
export const DECOR_SPECS = {
  lamp: {
    poleHeight: 6,
    poleBottomRadius: 0.12,
    poleTopRadius: 0.09,
    headHeight: 6.1,
    headRadius: 0.34,
  },
  antenna: {
    mastHeight: 5,
    mastBottomRadius: 0.08,
    mastTopRadius: 0.06,
    tipHeight: 5.1,
    tipRadius: 0.16,
  },
  crateStack: {
    /** Bottom crate first. Each is a cube of this edge length. */
    sizes: [1.4, 1.1, 0.8],
    stepX: 0.18,
    stepZ: 0.12,
    yawStepRad: 0.4,
  },
  pipeRun: {
    pipeCount: 3,
    pipeRadius: 0.13,
    firstPipeHeight: 0.55,
    pipeSpacing: 0.3,
    trestleWidth: 0.16,
    trestleHeight: 1.2,
    trestleDepth: 0.5,
    /** One trestle every this many metres of run, with a floor of two. */
    trestleEvery: 6,
    defaultLength: 20,
  },
} as const satisfies Record<DecorKind, Record<string, number | readonly number[]>>;

/**
 * The physical footprint of a decorative piece, in world space.
 *
 * Conservative by construction: where the mesh is round (a pole, a pipe) the box is the
 * enclosing one, and where a crate is yawed the box is the enclosing axis-aligned square.
 * Being slightly bigger than the paint is the safe direction — the failure it prevents is
 * "I am standing inside the lamp post", and a collision box that is a few centimetres proud
 * of a cylinder is not something a player can see.
 *
 * Pure, and exported so `tests/level.test.ts` can assert the two things that matter without
 * re-deriving them: every piece has a body, and every body is in both world lists.
 */
export function decorCollisionBoxes(decor: Decor): Aabb[] {
  const yaw = (decor.yawDeg ?? 0) * DEG2RAD;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  /** Rotates a local offset into world space, about Y. */
  const place = (offsetX: number, offsetY: number, offsetZ: number): Vector3 => ({
    x: decor.position.x + offsetX * cos + offsetZ * sin,
    y: decor.position.y + offsetY,
    z: decor.position.z - offsetX * sin + offsetZ * cos,
  });
  /** Enclosing half-extents of a yawed box. */
  const rotated = (halfX: number, halfY: number, halfZ: number, boxYaw: number): Vector3 => {
    const c = Math.abs(Math.cos(boxYaw));
    const s = Math.abs(Math.sin(boxYaw));
    return { x: halfX * c + halfZ * s, y: halfY, z: halfX * s + halfZ * c };
  };

  if (decor.kind === 'lamp') {
    const spec = DECOR_SPECS.lamp;
    // The pole only. The head is 6 m up and nothing can reach it, so a second box would be
    // a second thing to keep in step for no gameplay at all.
    return [
      {
        center: place(0, spec.poleHeight / 2, 0),
        halfExtents: rotated(spec.poleBottomRadius, spec.poleHeight / 2, spec.poleBottomRadius, yaw),
      },
    ];
  }

  if (decor.kind === 'antenna') {
    const spec = DECOR_SPECS.antenna;
    return [
      {
        center: place(0, spec.mastHeight / 2, 0),
        halfExtents: rotated(spec.mastBottomRadius, spec.mastHeight / 2, spec.mastBottomRadius, yaw),
      },
    ];
  }

  if (decor.kind === 'pipeRun') {
    const spec = DECOR_SPECS.pipeRun;
    const length = decor.length ?? spec.defaultLength;
    // The run's real top: the highest pipe plus its radius, which is above the trestles.
    const top = spec.firstPipeHeight + (spec.pipeCount - 1) * spec.pipeSpacing + spec.pipeRadius;
    return [
      {
        center: place(0, top / 2, 0),
        halfExtents: rotated(length / 2, top / 2, Math.max(spec.trestleDepth, spec.pipeRadius * 2) / 2, yaw),
      },
    ];
  }

  const spec = DECOR_SPECS.crateStack;
  const boxes: Aabb[] = [];
  let y = 0;
  for (let i = 0; i < spec.sizes.length; i += 1) {
    const size = spec.sizes[i] ?? 0;
    const half = size / 2;
    const offsetX = (i - 1) * spec.stepX;
    const offsetZ = (i - 1) * spec.stepZ;
    boxes.push({
      center: place(offsetX, y + half, offsetZ),
      // Each crate is yawed by its own angle inside the stack, so its enclosing box grows.
      halfExtents: rotated(half, half, half, i * spec.yawStepRad),
    });
    y += size;
  }
  return boxes;
}


/** Static target dummy placed for phase-1 weapon tuning. */
export interface TargetSpec {
  readonly id: number;
  /** Feet position; the body is stacked upward from here. */
  readonly base: Vector3;
  readonly bodyHeight: number;
  readonly bodyRadius: number;
  readonly headRadius: number;
  readonly health: number;
  /** Degrees of yaw, for a visible facing difference. */
  readonly yawDeg: number;
  /** Vertical bob amplitude in metres, so leading a moving target can be tested. */
  readonly bobAmplitude: number;
  /** Bob cycles per second. Zero means a fully static target. */
  readonly bobHz: number;
}

/** The complete level: geometry, decorative extras and the arena bounds. */
export interface LevelData {
  readonly props: readonly Prop[];
  readonly decor: readonly Decor[];
  readonly targets: readonly TargetSpec[];
  /**
   * Movement collision boxes: the ground slab, `props` and every decorative piece.
   *
   * This is the list `createCollisionWorld` reads, so it *is* the world the player and the
   * enemies walk in. (Until phase 6 it was a second, parallel derivation from `props` and
   * nothing in `src/` consumed it at all.)
   */
  readonly collisionBoxes: readonly Aabb[];
  /**
   * Bullet-blocking boxes only. Fences are deliberately absent: a visible
   * boundary that stops bullets reads as an invisible wall, so the fence stops
   * the player and lets rounds through.
   */
  readonly blockers: readonly Aabb[];
  /** Half-extent of the playable footprint. */
  readonly halfSize: number;
  readonly seed: number;
}

/** Arena footprint. Matches `SIM.arenaHalfSize`; asserted in tests. */
export const ARENA_HALF_SIZE = 24;
const FENCE_HEIGHT = 6.4;
const FENCE_THICKNESS = 0.6;
const WALL_SEGMENT_LENGTH = 4;

const COLORS = {
  // Phase 4 palette pass. Two rules, both about readability rather than taste:
  // the ground is a little darker so a 1.1 m Stalker silhouette keeps its contrast
  // against it, and the cover split is deliberate — warm (crates, barrels) reads as
  // "climbable clutter", cool (walls, pillars, fence) reads as "structure". Colour is
  // the only thing changed here: every size and position is untouched, so the
  // collision boxes and the blockers are bit-identical to phase 3.
  ground: 0x2f3742,
  fence: 0x99a4b2,
  crate: 0xc08347,
  pillar: 0x9aa4b0,
  lowWall: 0x68758a,
  platform: 0x7d8894,
  ramp: 0x707a87,
  barrel: 0xcf5a41,
} as const;

/**
 * Baseline cover, before seeded jitter.
 *
 * Hand-placed rather than generated: a random scatter produces rooms with no
 * sightlines and no interesting angles. The seed only perturbs this layout, it
 * does not author it.
 */
interface PropSeed {
  readonly id: string;
  readonly kind: PropKind;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  readonly blocksShots?: boolean;
  readonly solid?: boolean;
  /** Per-axis placement jitter in metres, from the level seed. */
  readonly jitter?: number;
}

const COVER_SEEDS: readonly PropSeed[] = [
  // --- Central cluster: the main sightline break in the middle of the arena.
  // Placed off the spawn axis on purpose. The player spawns at z = +8 looking
  // down −Z, and cover directly on that line would both block the shot and stop
  // the player from walking forward on their first step — which reads as "the
  // controls are broken" long before it reads as "that is a crate".
  { id: 'crate-a', kind: 'crate', x: -3.6, y: 0.6, z: -1.2, sx: 2.4, sy: 1.2, sz: 2.4 },
  { id: 'crate-a2', kind: 'crate', x: -3.6, y: 1.8, z: -1.2, sx: 1.8, sy: 1.2, sz: 1.8, jitter: 0.04 },
  { id: 'crate-b', kind: 'crate', x: 4.2, y: 0.6, z: -3.4, sx: 1.6, sy: 1.2, sz: 1.6, jitter: 0.1 },
  { id: 'crate-c', kind: 'crate', x: -6.8, y: 0.6, z: -2.4, sx: 1.6, sy: 1.2, sz: 1.6, jitter: 0.1 },
  { id: 'barrel-1', kind: 'barrel', x: 5.2, y: 0.55, z: 1.2, sx: 1.1, sy: 1.1, sz: 1.1, jitter: 0.12 },

  // --- A long wall that splits the northern half and creates two lanes.
  { id: 'wall-north', kind: 'lowWall', x: -6.5, y: 1.1, z: -12, sx: 12, sy: 2.2, sz: 0.8 },
  { id: 'wall-north-wing', kind: 'lowWall', x: -14.5, y: 1.1, z: -9, sx: 0.8, sy: 2.2, sz: 6.4 },

  // --- Eastern lane: a raised platform with a ramp, for elevation testing.
  { id: 'platform-east', kind: 'platform', x: 13, y: 1.5, z: 6, sx: 7, sy: 3, sz: 7 },
  { id: 'ramp-east', kind: 'ramp', x: 9.4, y: 0.75, z: 6, sx: 2.6, sy: 1.5, sz: 3.4 },

  // --- Western lane: pillars that break the left-hand sightline.
  { id: 'pillar-w1', kind: 'pillar', x: -11, y: 2, z: 2, sx: 1.8, sy: 4, sz: 1.8, jitter: 0.15 },
  { id: 'pillar-w2', kind: 'pillar', x: -11, y: 2, z: 7.5, sx: 1.8, sy: 4, sz: 1.8, jitter: 0.15 },
  { id: 'pillar-w3', kind: 'pillar', x: -7.5, y: 2, z: 4.6, sx: 1.8, sy: 4, sz: 1.8, jitter: 0.15 },

  // --- Southern approach: staggered low walls, the "run and gun" corridor.
  { id: 'wall-south-a', kind: 'lowWall', x: 4, y: 1.1, z: 12, sx: 7, sy: 2.2, sz: 0.8, jitter: 0.12 },
  { id: 'wall-south-b', kind: 'lowWall', x: -3.5, y: 1.1, z: 16, sx: 8, sy: 2.2, sz: 0.8, jitter: 0.12 },
  { id: 'crate-south', kind: 'crate', x: -9.5, y: 0.6, z: 12.5, sx: 2, sy: 1.2, sz: 2, jitter: 0.12 },
  { id: 'barrel-2', kind: 'barrel', x: 8.6, y: 0.55, z: 14.5, sx: 1.1, sy: 1.1, sz: 1.1, jitter: 0.12 },
  { id: 'barrel-3', kind: 'barrel', x: 7.2, y: 0.55, z: 16.2, sx: 1.1, sy: 1.1, sz: 1.1, jitter: 0.12 },

  // --- Far corners: midfield cover for longer engagements.
  { id: 'crate-ne', kind: 'crate', x: 17, y: 0.6, z: -15, sx: 2.2, sy: 1.2, sz: 2.2, jitter: 0.15 },
  { id: 'crate-nw', kind: 'crate', x: -17.5, y: 0.6, z: -16, sx: 2.2, sy: 1.2, sz: 2.2, jitter: 0.15 },
  { id: 'crate-sw', kind: 'crate', x: -18, y: 0.6, z: 17, sx: 2.2, sy: 1.2, sz: 2.2, jitter: 0.15 },
  { id: 'crate-se', kind: 'crate', x: 18.5, y: 0.6, z: 16, sx: 2.2, sy: 1.2, sz: 2.2, jitter: 0.15 },
];

/** Builds the fence ring: four solid rails plus posts, as collision boxes. */
function buildFence(half: number): { props: Prop[]; collision: Aabb[]; blockers: Aabb[] } {
  const props: Prop[] = [];
  const collision: Aabb[] = [];
  const halfExtent = half + FENCE_THICKNESS / 2;

  // Four rails laid as segments so the posts read as separate objects and the
  // fence does not become one 48 m box that kills frustum culling.
  const sides: { id: string; axis: 'x' | 'z'; sign: 1 | -1 }[] = [
    { id: 'north', axis: 'z', sign: -1 },
    { id: 'south', axis: 'z', sign: 1 },
    { id: 'west', axis: 'x', sign: -1 },
    { id: 'east', axis: 'x', sign: 1 },
  ];

  for (const side of sides) {
    const count = Math.round((half * 2) / WALL_SEGMENT_LENGTH);
    for (let i = 0; i < count; i += 1) {
      // Centre of this segment along the run axis.
      const along = -half + WALL_SEGMENT_LENGTH * (i + 0.5);
      const x = side.axis === 'x' ? side.sign * halfExtent : along;
      const z = side.axis === 'z' ? side.sign * halfExtent : along;
      const sx = side.axis === 'x' ? FENCE_THICKNESS : WALL_SEGMENT_LENGTH;
      const sz = side.axis === 'z' ? FENCE_THICKNESS : WALL_SEGMENT_LENGTH;

      props.push({
        id: `fence-${side.id}-${i}`,
        kind: 'fence',
        position: { x, y: FENCE_HEIGHT / 2, z },
        size: { x: sx, y: FENCE_HEIGHT, z: sz },
        color: COLORS.fence,
        solid: true,
        // A fence stops the player but not bullets: shooting through the bars is
        // the whole point of a visible boundary.
        blocksShots: false,
      });
      collision.push({
        center: { x, y: FENCE_HEIGHT / 2, z },
        halfExtents: { x: sx / 2, y: FENCE_HEIGHT / 2, z: sz / 2 },
      });
    }

    // Posts at the segment joints, purely decorative.
    for (let i = 0; i <= count; i += 1) {
      const along = -half + WALL_SEGMENT_LENGTH * i;
      const x = side.axis === 'x' ? side.sign * halfExtent : along;
      const z = side.axis === 'z' ? side.sign * halfExtent : along;
      const sx = side.axis === 'x' ? FENCE_THICKNESS * 1.6 : 0.35;
      const sz = side.axis === 'z' ? FENCE_THICKNESS * 1.6 : 0.35;
      props.push({
        id: `fencepost-${side.id}-${i}`,
        kind: 'fence',
        position: { x, y: (FENCE_HEIGHT + 0.8) / 2, z },
        size: { x: sx, y: FENCE_HEIGHT + 0.8, z: sz },
        color: COLORS.fence,
        solid: true,
        blocksShots: false,
      });
      collision.push({
        center: { x, y: (FENCE_HEIGHT + 0.8) / 2, z },
        halfExtents: { x: sx / 2, y: (FENCE_HEIGHT + 0.8) / 2, z: sz / 2 },
      });
    }
  }

  return { props, collision, blockers: [] };
}

/** Target dummies for phase-1 tuning: near / mid / far, and two elevated. */
function buildTargets(): TargetSpec[] {
  const specs: Omit<TargetSpec, 'id'>[] = [
    // The near pair sits close to the spawn axis so a player who just clicked in
    // has something to shoot without moving: two at chest height, one on the
    // floor, one elevated, all within the falloff-free band.
    { base: { x: 0, y: 0, z: -9 }, bodyHeight: 1.1, bodyRadius: 0.36, headRadius: 0.24, health: 200, yawDeg: 180, bobAmplitude: 0, bobHz: 0 },
    { base: { x: 2.6, y: 0, z: -10.5 }, bodyHeight: 1.1, bodyRadius: 0.36, headRadius: 0.24, health: 200, yawDeg: 180, bobAmplitude: 0, bobHz: 0 },
    // Mid range: still inside the falloff start, so damage is still at full value.
    { base: { x: 7.5, y: 0, z: -17 }, bodyHeight: 1.1, bodyRadius: 0.36, headRadius: 0.24, health: 300, yawDeg: 160, bobAmplitude: 0, bobHz: 0 },
    { base: { x: -7.5, y: 0, z: -17 }, bodyHeight: 1.1, bodyRadius: 0.36, headRadius: 0.24, health: 300, yawDeg: 200, bobAmplitude: 0, bobHz: 0 },
    // Long range: past the falloff start, exercises the decay curve.
    { base: { x: 16.5, y: 0, z: -20.5 }, bodyHeight: 1.1, bodyRadius: 0.34, headRadius: 0.22, health: 300, yawDeg: 150, bobAmplitude: 0, bobHz: 0 },
    { base: { x: -16.5, y: 0, z: 20.5 }, bodyHeight: 1.1, bodyRadius: 0.34, headRadius: 0.22, health: 300, yawDeg: 330, bobAmplitude: 0, bobHz: 0 },
    // Elevated on the east platform: verifies that pitch and 3D range agree.
    { base: { x: 13, y: 3, z: 6 }, bodyHeight: 1.1, bodyRadius: 0.36, headRadius: 0.24, health: 200, yawDeg: 270, bobAmplitude: 0, bobHz: 0 },
    // Moving target: a slow lateral bob, for tracking and lead.
    { base: { x: -13, y: 3, z: 6 }, bodyHeight: 1.1, bodyRadius: 0.36, headRadius: 0.24, health: 250, yawDeg: 90, bobAmplitude: 1.6, bobHz: 0.35 },
  ];

  return specs.map((spec, index) => ({ ...spec, id: index + 1 }));
}

/**
 * The decorative pieces, as data.
 *
 * ## What this channel is for (and is no longer for)
 *
 * The level's *cover* is authored in `props`, which derives the meshes, the movement
 * collision boxes **and** the bullet blockers at once — that is what keeps "the wall you
 * can see" and "the wall that stops bullets" the same wall. This list is for the pieces
 * that are placed by hand and built by a dedicated mesh builder: the perimeter lamps, the
 * masts, the crate stacks and the pipe runs.
 *
 * Phase 4 made that list non-colliding on purpose, on the grounds that dressing the level
 * up should not change what the player can walk through. The player-visible result was
 * worse than the coupling it avoided: you walked through lamp posts and pipe runs, which
 * reads as a broken game and not as a deliberately empty collision world. Since phase 6
 * every piece here derives its collision boxes from {@link DECOR_SPECS} — the same numbers
 * the meshes are built from — so it is physical *and* cannot drift from its paint. What the
 * channel still buys is the thing it was really for: these pieces come from a list with
 * their own mesh builders, so they are not `props` and cannot be confused with cover.
 */
function buildDecor(): Decor[] {
  return [
    // --- Perimeter lighting ---------------------------------------------------
    // A full ring rather than the four corners: with the fog fading the fence, the
    // lamps are what actually says "the arena ends here, and it ends deliberately".
    { kind: 'lamp', position: { x: 20.5, y: 0, z: 20.5 } },
    { kind: 'lamp', position: { x: -20.5, y: 0, z: 20.5 } },
    { kind: 'lamp', position: { x: 20.5, y: 0, z: -20.5 } },
    { kind: 'lamp', position: { x: -20.5, y: 0, z: -20.5 } },
    { kind: 'lamp', position: { x: 20.5, y: 0, z: 0 } },
    { kind: 'lamp', position: { x: -20.5, y: 0, z: 0 } },
    { kind: 'lamp', position: { x: 0, y: 0, z: -20.5 } },
    { kind: 'lamp', position: { x: 0, y: 0, z: 20.5 } },

    // --- Masts ----------------------------------------------------------------
    { kind: 'antenna', position: { x: 16.5, y: 3, z: 8.5 } },
    { kind: 'antenna', position: { x: -18.5, y: 0, z: 4 } },
    { kind: 'antenna', position: { x: 6, y: 0, z: -19.5 } },

    // --- Storage clutter along the walls -------------------------------------
    { kind: 'crateStack', position: { x: -20, y: 0, z: -6 } },
    { kind: 'crateStack', position: { x: 19.5, y: 0, z: 12 } },
    { kind: 'crateStack', position: { x: -12, y: 0, z: 20 } },
    { kind: 'crateStack', position: { x: 20, y: 0, z: -9 } },

    // --- Pipe runs ------------------------------------------------------------
    // Long, low, and parallel to the fence: they give the perimeter a horizontal
    // line to read against the vertical fence posts, which is most of what stops a
    // 48 m box from looking like four flat walls.
    //
    // **They hug the fence, and that is a collision decision rather than a taste one.**
    // They became solid in phase 6, and the enemy AI has no pathfinding — it seeks and is
    // then pushed out along the shallowest axis. A run parked 2.5 m off the wall would
    // therefore cut a corridor off behind itself that a spawn could land in and that an
    // enemy could only slide along, for as long as it takes to reach the end of the run.
    // At 23.0 m the run's arena-side face (22.75 m) is outside the spawn band (21.6 m), so
    // the corridor is unreachable by construction. `tests/level.test.ts` pins that.
    { kind: 'pipeRun', position: { x: 0, y: 0, z: -23 }, yawDeg: 0, length: 34 },
    { kind: 'pipeRun', position: { x: -23, y: 0, z: -2 }, yawDeg: 90, length: 28 },
    { kind: 'pipeRun', position: { x: 23, y: 0, z: 4 }, yawDeg: 90, length: 22 },
  ];
}

/** Ground slab. Kept separate from `props` so the renderer can tile it. */
export const GROUND_PROP: Prop = {
  id: 'ground',
  kind: 'ground',
  position: { x: 0, y: -0.5, z: 0 },
  size: { x: ARENA_HALF_SIZE * 2 + 2, y: 1, z: ARENA_HALF_SIZE * 2 + 2 },
  color: COLORS.ground,
  solid: true,
  blocksShots: true,
};

function toAabb(prop: Prop): Aabb {
  return {
    center: prop.position,
    halfExtents: { x: prop.size.x / 2, y: prop.size.y / 2, z: prop.size.z / 2 },
  };
}

/**
 * Builds the level. Pure: same seed in, byte-identical layout out.
 *
 * @param seed Optional seed override. Defaults to the `"box-garden"` hash so the
 *             shipped whitebox never shifts under the player between sessions.
 */
export function buildLevel(seed: number = seedFromString('box-garden-level-1')): LevelData {  const rng = createRng(seed);
  const half = ARENA_HALF_SIZE;

  const props: Prop[] = [GROUND_PROP];
  const collisionBoxes: Aabb[] = [toAabb(GROUND_PROP)];
  const blockers: Aabb[] = [toAabb(GROUND_PROP)];

  for (const spec of COVER_SEEDS) {
    const jitter = spec.jitter ?? 0;
    const prop: Prop = {
      id: spec.id,
      kind: spec.kind,
      position: {
        x: spec.x + rng.range(-jitter, jitter),
        y: spec.y,
        z: spec.z + rng.range(-jitter, jitter),
      },
      size: { x: spec.sx, y: spec.sy, z: spec.sz },
      color: COLORS[spec.kind],
      solid: spec.solid ?? true,
      blocksShots: spec.blocksShots ?? true,
    };
    props.push(prop);
    const box = toAabb(prop);
    if (prop.solid) collisionBoxes.push(box);
    if (prop.blocksShots) blockers.push(box);
  }

  const fence = buildFence(half);
  props.push(...fence.props);
  collisionBoxes.push(...fence.collision);
  // Fence explicitly does not block shots, so it is absent from `blockers`.

  // --- Decorative pieces (phase 6) -----------------------------------------
  // Every one of them is physical: the same boxes go into the movement list and the
  // bullet list, so a lamp post stops a player *and* a round. The fence is the only piece
  // of the level allowed to stop one and not the other, and that is a deliberate,
  // separately asserted decision (see `blockers`).
  const decor = buildDecor();
  for (const piece of decor) {
    for (const box of decorCollisionBoxes(piece)) {
      collisionBoxes.push(box);
      blockers.push(box);
    }
  }

  return {
    props,
    decor,
    targets: buildTargets(),
    collisionBoxes,
    blockers,
    halfSize: half,
    seed,
  };
}
